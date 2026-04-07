import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { CompactMessage } from './compact/types.js';
import {
  buildCompactionHeader,
  prepareMessagesForPrompt,
} from './compact/prompt-preparation.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  sessionId?: string,
): string {
  if (!messages || messages.length === 0) {
    return `<context timezone="${escapeXml(timezone)}" />\n<messages>\n</messages>`;
  }

  let finalMessages: CompactMessage[] = messages as CompactMessage[];

  const prepared = prepareMessagesForPrompt(finalMessages, sessionId);
  finalMessages = prepared.messages;
  const compressionMetadata = buildCompactionHeader(prepared.compactResult);

  const lines = finalMessages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const compactAttr = m.isCompacted
      ? ` compacted="true" compact_level="${m.compactLevel}"`
      : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${compactAttr}>${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}"${compressionMetadata} />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
