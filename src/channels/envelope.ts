// The normalized message envelope + Channel contract shared by every adapter. Kept
// channel-generic so a WhatsApp Cloud API adapter can be added later without touching the
// agent loop.

export type ChannelId = 'whatsapp' | 'whatsapp_cloud';

export interface Capabilities {
  media: boolean;
  voice: boolean;
  replyTo: boolean;
  reactions: boolean;
  typing: boolean;
}

export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export interface InboundMedia {
  path: string; // local file path the adapter downloaded to
  mime: string;
  kind: MediaKind;
  isVoice?: boolean;
}

export interface InboundMessage {
  channel: ChannelId;
  accountId: string;
  chatId: string; // reply target (a JID / chat id)
  senderId: string; // stable per-sender id
  senderName?: string;
  senderE164?: string; // phone number without + (WhatsApp)
  isGroup: boolean;
  fromMe: boolean;
  text: string;
  mentionedSelf: boolean;
  replyToId?: string;
  media?: InboundMedia;
  timestamp: number;
  raw: unknown;
}

export interface OutboundOptions {
  replyToId?: string;
  asVoice?: boolean;
}

export interface OutboundMedia {
  path: string;
  mime: string;
  caption?: string;
}

export interface SendResult {
  messageId: string;
  chatId: string;
  timestamp: number;
}

export interface Channel {
  readonly id: ChannelId;
  readonly accountId: string;
  readonly capabilities: Capabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(cb: (m: InboundMessage) => void): void;
  sendText(to: string, text: string, opts?: OutboundOptions): Promise<SendResult>;
  sendMedia(to: string, media: OutboundMedia, opts?: OutboundOptions): Promise<SendResult>;
  setTyping?(to: string, on: boolean): Promise<void>;
}

/** sessionKey scopes per-sender conversation state across channels/accounts. */
export function sessionKey(m: InboundMessage): string {
  return `${m.channel}:${m.accountId}:${m.chatId}`;
}
