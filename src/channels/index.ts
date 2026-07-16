// ChannelRouter (ported from swimbot): starts every configured channel adapter, fans inbound
// messages to one handler, and routes outbound sends by channel id.

import type {
  Channel,
  ChannelId,
  InboundMessage,
  OutboundMedia,
  OutboundOptions,
  SendResult,
} from './envelope.js';

export class ChannelRouter {
  private channels = new Map<string, Channel>();
  private handler: ((m: InboundMessage) => void) | null = null;

  register(channel: Channel): void {
    this.channels.set(`${channel.id}:${channel.accountId}`, channel);
    channel.onMessage((m) => this.handler?.(m));
  }

  onMessage(cb: (m: InboundMessage) => void): void {
    this.handler = cb;
  }

  async start(): Promise<void> {
    await Promise.all([...this.channels.values()].map((c) => c.start()));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.channels.values()].map((c) => c.stop().catch(() => {})));
  }

  private resolve(channel: ChannelId, accountId = 'default'): Channel {
    const c = this.channels.get(`${channel}:${accountId}`);
    if (!c) throw new Error(`no channel registered for ${channel}:${accountId}`);
    return c;
  }

  sendText(
    channel: ChannelId,
    to: string,
    text: string,
    opts?: OutboundOptions & { accountId?: string },
  ): Promise<SendResult> {
    return this.resolve(channel, opts?.accountId).sendText(to, text, opts);
  }

  sendMedia(
    channel: ChannelId,
    to: string,
    media: OutboundMedia,
    opts?: OutboundOptions & { accountId?: string },
  ): Promise<SendResult> {
    return this.resolve(channel, opts?.accountId).sendMedia(to, media, opts);
  }

  async setTyping(
    channel: ChannelId,
    to: string,
    on: boolean,
    opts?: { accountId?: string },
  ): Promise<void> {
    await this.resolve(channel, opts?.accountId).setTyping?.(to, on);
  }
}
