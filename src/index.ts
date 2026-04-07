import fs from 'fs';
import path from 'path';

import {
  AGENT_MAX_RETRIES,
  AGENT_RETRY_BASE_MS,
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  deleteRegisteredGroup,
  deleteSession,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  createNormalizedRunState,
  markNormalizedOutput,
  markNormalizedStreamEvent,
} from './run-lifecycle.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { ensureMountAllowlist } from './mount-security.js';
import { acquireServiceLock, releaseServiceLock } from './service-lock.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { shouldRetryTransientAttempt } from './transient-retry.js';
import {
  AdditionalMount,
  Channel,
  NewMessage,
  RegisteredGroup,
  SessionState,
} from './types.js';
import { logger } from './logger.js';
import { TerminalAgentSummary, TerminalChannel } from './terminal-channel.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, SessionState> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const TERMINAL_MODE = process.argv.includes('--terminal');

function isLocalTerminalJid(jid: string): boolean {
  return jid.startsWith('local:');
}

function slugifyLocalAgentName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) {
    throw new Error('Agent name must contain letters or numbers');
  }
  return normalized.slice(0, 54);
}

function getLocalTerminalAgents(): Array<
  TerminalAgentSummary & { group: RegisteredGroup }
> {
  return Object.entries(registeredGroups)
    .filter(([jid]) => isLocalTerminalJid(jid))
    .map(([jid, group]) => {
      const runtime = queue.getGroupRuntimeStatus(jid);
      const mounts =
        group.containerConfig?.additionalMounts?.map((mount) => {
          const mode = mount.readonly === false ? 'rw' : 'ro';
          return `${mount.hostPath} (${mode})`;
        }) || [];
      let status = 'idle';
      if (runtime.isTaskContainer) status = 'task';
      else if (runtime.active && runtime.idleWaiting) status = 'waiting-input';
      else if (runtime.active) status = 'running';

      return {
        jid,
        name: group.name,
        folder: group.folder,
        active: runtime.active,
        status,
        sessionId: sessions[group.folder]?.sessionId || null,
        containerName: runtime.containerName,
        mounts,
        group,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolveLocalTerminalAgent(
  query: string,
): (TerminalAgentSummary & { group: RegisteredGroup }) | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const agents = getLocalTerminalAgents();
  const exact =
    agents.find((agent) => agent.jid.toLowerCase() === q) ||
    agents.find((agent) => agent.folder.toLowerCase() === q) ||
    agents.find((agent) => agent.name.toLowerCase() === q);
  if (exact) return exact;

  const partial = agents.filter(
    (agent) =>
      agent.folder.toLowerCase().includes(q) ||
      agent.name.toLowerCase().includes(q),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Ambiguous agent "${query}": ${partial.map((agent) => agent.name).join(', ')}`,
    );
  }
  return null;
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function upsertSessionState(
  groupFolder: string,
  updates: Partial<SessionState> & Pick<SessionState, 'sessionId'>,
): void {
  const nextState: SessionState = {
    sessionId: updates.sessionId,
    resumeAt:
      updates.resumeAt !== undefined
        ? updates.resumeAt
        : sessions[groupFolder]?.resumeAt || null,
  };
  sessions[groupFolder] = nextState;
  setSession(groupFolder, nextState);
}

function clearSessionState(groupFolder: string): void {
  delete sessions[groupFolder];
  deleteSession(groupFolder);
}

function isMissingConversationError(error?: string): boolean {
  return !!error && /No conversation found with session ID/i.test(error);
}

function isMissingResumePointError(error?: string): boolean {
  return !!error && /No message found with message\.uuid/i.test(error);
}

function persistSessionFromOutput(
  groupFolder: string,
  output: ContainerOutput,
  fallbackSessionId?: string,
): void {
  const nextSessionId = output.newSessionId || fallbackSessionId;
  if (!nextSessionId) return;

  if (isMissingConversationError(output.error)) {
    return;
  }

  if (isMissingResumePointError(output.error)) {
    upsertSessionState(groupFolder, {
      sessionId: nextSessionId,
      resumeAt: null,
    });
    return;
  }

  upsertSessionState(groupFolder, {
    sessionId: nextSessionId,
    resumeAt: output.lastAssistantUuid,
  });
}
function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function createLocalTerminalAgent(
  name: string,
  options?: { mounts?: string[]; readWrite?: boolean },
): {
  agent: TerminalAgentSummary;
  created: boolean;
} {
  if (options?.mounts && options.mounts.length > 0) {
    ensureMountAllowlist(options.mounts, {
      readWrite: options.readWrite,
    });
  }

  const existing = resolveLocalTerminalAgent(name);
  if (existing) {
    if (options?.mounts && options.mounts.length > 0) {
      const currentMounts =
        existing.group.containerConfig?.additionalMounts || [];
      const mergedMounts = [...currentMounts];

      for (const hostPath of options.mounts) {
        const index = mergedMounts.findIndex(
          (mount) => mount.hostPath === hostPath,
        );
        const nextMount = {
          hostPath,
          readonly: options.readWrite ? false : true,
        };

        if (index >= 0) mergedMounts[index] = nextMount;
        else mergedMounts.push(nextMount);
      }

      const updatedGroup: RegisteredGroup = {
        ...existing.group,
        containerConfig: {
          ...existing.group.containerConfig,
          additionalMounts: mergedMounts,
        },
      };
      registeredGroups[existing.jid] = updatedGroup;
      setRegisteredGroup(existing.jid, updatedGroup);
      existing.group = updatedGroup;
      existing.mounts = mergedMounts.map((mount) => {
        const mode = mount.readonly === false ? 'rw' : 'ro';
        return `${mount.hostPath} (${mode})`;
      });
    }

    return {
      created: false,
      agent: {
        jid: existing.jid,
        name: existing.name,
        folder: existing.folder,
        active: existing.active,
        status: existing.status,
        sessionId: existing.sessionId,
        containerName: existing.containerName,
        mounts: existing.mounts,
      },
    };
  }

  const baseFolder = `local-${slugifyLocalAgentName(name)}`;
  let folder = baseFolder;
  let suffix = 2;
  while (
    Object.values(registeredGroups).some((group) => group.folder === folder)
  ) {
    folder = `${baseFolder}-${suffix}`;
    suffix += 1;
  }

  if (!isValidGroupFolder(folder)) {
    throw new Error(`Cannot create valid folder for agent "${name}"`);
  }

  const jid = `local:${folder}`;
  const now = new Date().toISOString();
  const additionalMounts: AdditionalMount[] | undefined =
    options?.mounts && options.mounts.length > 0
      ? options.mounts.map((hostPath) => ({
          hostPath,
          readonly: options.readWrite ? false : true,
        }))
      : undefined;
  registerGroup(jid, {
    name,
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: now,
    containerConfig: additionalMounts ? { additionalMounts } : undefined,
    requiresTrigger: false,
  });
  storeChatMetadata(jid, now, name, 'terminal', false);

  return {
    created: true,
    agent: {
      jid,
      name,
      folder,
      active: queue.isGroupActive(jid),
      status: 'idle',
      sessionId: sessions[folder]?.sessionId || null,
      containerName: null,
      mounts:
        additionalMounts?.map((mount) => {
          const mode = mount.readonly === false ? 'rw' : 'ro';
          return `${mount.hostPath} (${mode})`;
        }) || [],
    },
  };
}

function deleteLocalTerminalAgent(
  query: string,
): { agent: TerminalAgentSummary } | null {
  const resolved = resolveLocalTerminalAgent(query);
  if (!resolved) return null;

  queue.closeStdin(resolved.jid);
  delete registeredGroups[resolved.jid];
  deleteRegisteredGroup(resolved.jid);
  deleteSession(resolved.folder);
  delete lastAgentTimestamp[resolved.jid];
  saveState();

  const groupPath = resolveGroupFolderPath(resolved.folder);
  fs.rmSync(groupPath, { recursive: true, force: true });

  const ipcPath = resolveGroupIpcPath(resolved.folder);
  fs.rmSync(ipcPath, { recursive: true, force: true });

  const sessionPath = path.join(DATA_DIR, 'sessions', resolved.folder);
  const sessionBase = path.resolve(DATA_DIR, 'sessions');
  const relative = path.relative(sessionBase, sessionPath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  return {
    agent: {
      jid: resolved.jid,
      name: resolved.name,
      folder: resolved.folder,
      active: resolved.active,
      status: resolved.status,
      sessionId: resolved.sessionId,
      containerName: resolved.containerName,
      mounts: resolved.mounts,
    },
  };
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

export const __testInternals = {
  persistSessionFromOutput,
  processGroupMessages,
  runAgent,
  upsertSessionState,
};

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
function normalizeTurnCompletion(state: {
  sentVisibleResult: boolean;
  observedQueryCompleted: boolean;
  observedStreamCompletion: boolean;
}): boolean {
  return (
    state.sentVisibleResult ||
    state.observedQueryCompleted ||
    state.observedStreamCompletion
  );
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const sessionId =
    sessions[chatJid]?.sessionId ||
    sessions[group.folder]?.sessionId ||
    'default';
  const prompt = formatMessages(missedMessages, TIMEZONE, sessionId);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  const normalizedTurn = createNormalizedRunState();

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    markNormalizedOutput(normalizedTurn, result);

    if (result.event) {
      await channel.sendAgentEvent?.(chatJid, result.event);
      if (result.event.type === 'assistant') {
        normalizedTurn.sentVisibleResult = true;
      }
      resetIdleTimer();
    }

    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks �?agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        normalizedTurn.sentVisibleResult = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.queryCompleted) {
      queue.notifyIdle(chatJid);
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // Partial streaming output is not enough to treat the turn as completed.
    // Only preserve the advanced cursor after the query actually completed
    // or a final message/result was delivered to the user.
    if (normalizeTurnCompletion(normalizedTurn)) {
      logger.warn(
        { group: group.name },
        'Agent error after completed output, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  retryOnInvalidSession: boolean = true,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const maxAttempts = Math.max(1, AGENT_MAX_RETRIES + 1);
  let allowSessionRepair = retryOnInvalidSession;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const session = sessions[group.folder];
    const sessionId = session?.sessionId;
    const resumeAt = session?.resumeAt || undefined;
    const normalizedAttempt = createNormalizedRunState();

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          persistSessionFromOutput(group.folder, output, sessionId);
          markNormalizedOutput(normalizedAttempt, output);
          await onOutput(output);
        }
      : async (output: ContainerOutput) => {
          persistSessionFromOutput(group.folder, output, sessionId);
          markNormalizedOutput(normalizedAttempt, output);
        };

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          resumeAt,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
        async (event) => {
          markNormalizedStreamEvent(normalizedAttempt, event);
          const channel = findChannel(channels, chatJid);
          await channel?.handleStreamEvent?.(chatJid, event);
        },
      );

      if (output.status === 'error') {
        if (
          allowSessionRepair &&
          sessionId &&
          isMissingConversationError(output.error)
        ) {
          logger.warn(
            { group: group.name, sessionId, error: output.error },
            'Stored session is no longer valid, clearing it and retrying once',
          );
          clearSessionState(group.folder);
          allowSessionRepair = false;
          continue;
        }

        if (
          allowSessionRepair &&
          sessionId &&
          resumeAt &&
          isMissingResumePointError(output.error)
        ) {
          logger.warn(
            { group: group.name, sessionId, resumeAt, error: output.error },
            'Stored resume cursor is no longer valid, clearing it and retrying once',
          );
          upsertSessionState(group.folder, {
            sessionId: output.newSessionId || sessionId,
            resumeAt: null,
          });
          allowSessionRepair = false;
          continue;
        }

        if (
          shouldRetryTransientAttempt({
            attempt,
            maxAttempts,
            error: output.error,
            sentVisibleResult: normalizedAttempt.sentVisibleResult,
            observedCompletion:
              normalizedAttempt.observedQueryCompleted ||
              normalizedAttempt.observedStreamCompletion,
          })
        ) {
          const delayMs = AGENT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          logger.warn(
            {
              group: group.name,
              attempt,
              maxAttempts,
              delayMs,
              error: output.error,
            },
            'Container turn hit a transient provider error, retrying',
          );
          await wait(delayMs);
          continue;
        }

        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }

      return 'success';
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (
        shouldRetryTransientAttempt({
          attempt,
          maxAttempts,
          error,
          sentVisibleResult: normalizedAttempt.sentVisibleResult,
          observedCompletion:
            normalizedAttempt.observedQueryCompleted ||
            normalizedAttempt.observedStreamCompletion,
        })
      ) {
        const delayMs = AGENT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(
          { group: group.name, attempt, maxAttempts, delayMs, error },
          'Container turn threw a transient provider error, retrying',
        );
        await wait(delayMs);
        continue;
      }

      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  return 'error';
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const sessionId =
            sessions[chatJid]?.sessionId ||
            sessions[group.folder]?.sessionId ||
            'default';
          const formatted = formatMessages(messagesToSend, TIMEZONE, sessionId);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container �?enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  acquireServiceLock();
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    releaseServiceLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands �?intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing �?skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }

  if (TERMINAL_MODE) {
    const terminalChannel = new TerminalChannel({
      onMessage: channelOpts.onMessage,
      onChatMetadata: channelOpts.onChatMetadata,
      listAgents: () =>
        getLocalTerminalAgents().map((agent) => ({
          jid: agent.jid,
          name: agent.name,
          folder: agent.folder,
          active: agent.active,
          status: agent.status,
          sessionId: agent.sessionId,
          containerName: agent.containerName,
          mounts: agent.mounts,
        })),
      createAgent: ({ name, mounts, readWrite }) =>
        createLocalTerminalAgent(name, { mounts, readWrite }),
      deleteAgent: (query) => deleteLocalTerminalAgent(query),
      resolveAgent: (query) => {
        const resolved = resolveLocalTerminalAgent(query);
        if (!resolved) return null;
        return {
          jid: resolved.jid,
          name: resolved.name,
          folder: resolved.folder,
          active: resolved.active,
          status: resolved.status,
          sessionId: resolved.sessionId,
          containerName: resolved.containerName,
          mounts: resolved.mounts,
        };
      },
    });
    channels.push(terminalChannel);
    await terminalChannel.connect();
  }

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    upsertSession: (groupFolder, session) =>
      upsertSessionState(groupFolder, session),
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
