// Declarative allowlist of the actions Mate may perform on the user's behalf — ported verbatim
// from SusuMate's app/Agent/ApiBridge/EndpointCatalog.php. Each entry maps to a real API route;
// the client runs it as the user so validation + authorization + country gating are reused.
//
// Flags:
//  - sensitive:  a write/money action — hidden in group chats (private only).
//  - confirm:    money/destructive — Mate must preview (confirm=false) then call again with
//                confirm=true after the user agrees.
//  - group_safe: safe to expose when Mate is @mentioned in a group chat.
//
// params:  path placeholders ({group}, {payout}, …) supplied as tool args.
// body:    JSON-schema properties passed straight to the endpoint.
// files:   image-by-URL (or WhatsApp "attached") fields uploaded as multipart.

type Prop = Record<string, unknown>;

export interface FileSpec {
  arg: string;
  multiple: boolean;
}

export interface CatalogEntry {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  summary: string;
  params?: string[];
  body?: Record<string, Prop>;
  files?: Record<string, FileSpec>;
  constants?: Record<string, string>;
  required?: string[];
  sensitive?: boolean;
  confirm?: boolean;
  group_safe?: boolean;
}

const str = (d: string): Prop => ({ type: 'string', description: d });
const num = (d: string): Prop => ({ type: 'number', description: d });
const enm = (v: string[], d: string): Prop => ({ type: 'string', enum: v, description: d });

function transferBody(): Record<string, Prop> {
  return {
    amount: num('Amount to move (GHS)'),
    destination_country: enm(['GH', 'NG'], ''),
    destination_method: enm(['momo', 'bank'], 'NG is bank only'),
    destination_channel: enm(['1', '6', '7'], 'MoMo network (momo)'),
    destination_phone: str('Recipient phone +233... (momo)'),
    destination_bank_code: str('Bank code (bank)'),
    destination_bank_name: str('Bank name (bank)'),
    destination_account_number: str('Account number (bank)'),
    destination_account_name: str('Account name (bank, optional)'),
  };
}

export const CATALOG: Record<string, CatalogEntry> = {
  // ── Profile / account ─────────────────────────────────────────
  me_get: {
    method: 'GET', path: 'me', group_safe: false,
    summary: "Get the signed-in user's profile (name, phone, country, payout method).",
  },
  me_update_profile: {
    method: 'POST', path: 'me', sensitive: true,
    summary: "Update the user's display name (used in onboarding) and/or avatar URL.",
    body: { name: str('Display name, 1-100 chars'), avatar_url: str('Optional avatar image URL') },
  },
  me_change_phone_request: {
    method: 'POST', path: 'me/phone/request-otp', sensitive: true,
    summary: 'Send an OTP to a new phone number the user wants to switch to.',
    body: { phone: str('New phone in E.164, e.g. +233...') }, required: ['phone'],
  },
  me_change_phone_confirm: {
    method: 'POST', path: 'me/phone/confirm', sensitive: true,
    summary: 'Confirm a phone-number change with the OTP code.',
    body: { phone: str('New phone'), code: str('6-digit code') }, required: ['phone', 'code'],
  },
  me_delete_account: {
    method: 'DELETE', path: 'me', sensitive: true, confirm: true,
    summary: "Permanently delete the user's account (blocked if they have financial activity). Requires their exact phone to confirm.",
    body: { phone_confirmation: str("The user's full phone number, exactly") }, required: ['phone_confirmation'],
  },

  // ── Groups ────────────────────────────────────────────────────
  groups_list: { method: 'GET', path: 'groups', summary: "List the user's groups (active + pending invites) with balances." },
  groups_explore: { method: 'GET', path: 'groups/public', group_safe: true, summary: 'Discover approved public groups/campaigns to support.' },
  groups_get: { method: 'GET', path: 'groups/{group}', params: ['group'], summary: "Get one group's detail (members, rotation, settings)." },
  groups_create: {
    method: 'POST', path: 'groups', sensitive: true,
    summary: 'Create a private savings group. rotational needs contribution_amount + frequency; pot needs contribution_type. For PUBLIC campaigns use groups_create_campaign.',
    body: {
      name: str('Group name'),
      visibility: enm(['private'], 'Use groups_create_campaign for public'),
      type: enm(['rotational', 'pot'], 'rotational = turns; pot = shared fund'),
      contribution_type: enm(['fixed', 'variable'], 'pot only'),
      contribution_amount: num('Per-member amount per round (rotational/fixed)'),
      frequency: enm(['daily', 'weekly', 'monthly'], 'rotational only'),
      fee_plan: enm(['split', 'full_payout'], 'Fee handling'),
    },
    required: ['name', 'visibility', 'type'],
  },
  groups_create_campaign: {
    method: 'POST', path: 'groups', sensitive: true,
    summary: 'Create a PUBLIC fundraising campaign (a pot open to everyone). Needs goal, category, story, start/end dates and a cover image. Goes live after SusuMate staff approve it.',
    constants: { visibility: 'public', type: 'pot', media_type: 'photo' },
    body: {
      name: str('Campaign title'),
      description: str('Short summary'),
      goal_amount: num('Fundraising target (GHS)'),
      category: str('Category, e.g. Health, Education'),
      story: str('The full story / why'),
      fundraising_for: enm(['myself', 'someone_else', 'community'], ''),
      charity_id: str('Charity id (only when fundraising_for=community)'),
      beneficiary_name: str('Beneficiary name (fundraising_for=someone_else)'),
      beneficiary_relationship: str('Relationship (fundraising_for=someone_else)'),
      start_date: str('Start date YYYY-MM-DD'),
      end_date: str('End date YYYY-MM-DD, after start'),
    },
    files: {
      cover_image: { arg: 'cover_image_url', multiple: false },
      additional_images: { arg: 'additional_image_urls', multiple: true },
    },
    required: ['name', 'description', 'goal_amount', 'category', 'story', 'fundraising_for', 'start_date', 'end_date', 'cover_image_url'],
  },
  groups_submit_public: {
    method: 'POST', path: 'groups/{group}/submit-public', params: ['group'], sensitive: true,
    summary: 'Edit and (re)submit an existing public campaign for approval, optionally with a new cover image.',
    constants: { media_type: 'photo' },
    body: {
      name: str('Campaign title'),
      description: str('Short summary'),
      goal_amount: num('Fundraising target (GHS)'),
      category: str('Category'),
      story: str('The full story'),
      fundraising_for: enm(['myself', 'someone_else', 'community'], ''),
      start_date: str('Start date YYYY-MM-DD'),
      end_date: str('End date YYYY-MM-DD'),
    },
    files: {
      cover_image: { arg: 'cover_image_url', multiple: false },
      additional_images: { arg: 'additional_image_urls', multiple: true },
    },
  },
  groups_update_settings: {
    method: 'POST', path: 'groups/{group}/settings', params: ['group'], sensitive: true,
    summary: "Edit a private group's contribution/payout settings (admin only).",
    body: {
      contribution_type: enm(['fixed', 'variable'], ''),
      contribution_amount: num('Fixed amount'),
      payout_mode: enm(['auto', 'admin'], 'rotational payout trigger'),
      allow_installments: { type: 'boolean', description: 'Allow paying the share in bits' },
      cashout_policy: enm(['percent', 'admins'], ''),
      cashout_percent: { type: 'integer', enum: [25, 50, 75, 100], description: 'Approval threshold' },
      fee_plan: enm(['split', 'full_payout'], ''),
    },
  },
  groups_activate: { method: 'POST', path: 'groups/{group}/activate', params: ['group'], sensitive: true, summary: 'Activate a group so saving can begin (admin only).' },
  groups_rotation: { method: 'GET', path: 'groups/{group}/rotation', params: ['group'], summary: 'Get the rotational payout queue (who is paid/current/upcoming).' },
  groups_disburse_round: { method: 'POST', path: 'groups/{group}/disburse-round', params: ['group'], sensitive: true, confirm: true, summary: "Release a fully-funded rotational round's payout (admin only)." },
  groups_invite: {
    method: 'POST', path: 'groups/{group}/invite', params: ['group'], sensitive: true,
    summary: 'Invite one person by phone (admin only). Rotational groups are Ghana-only.',
    body: { phone: str('Phone in E.164, e.g. +233...') }, required: ['phone'],
  },
  groups_invite_bulk: {
    method: 'POST', path: 'groups/{group}/invite-bulk', params: ['group'], sensitive: true,
    summary: 'Invite several people at once by phone (admin only).',
    body: { phones: { type: 'array', items: { type: 'string' }, description: 'Phones in E.164, e.g. +233...' } },
    required: ['phones'],
  },
  groups_respond: {
    method: 'POST', path: 'groups/{group}/respond', params: ['group'], sensitive: true,
    summary: 'Respond to a group: accept or decline an invite, or request to join a public group.',
    body: { action: enm(['accept', 'decline', 'request'], '') }, required: ['action'],
  },
  groups_approve_member: {
    method: 'POST', path: 'groups/{group}/approve-member', params: ['group'], sensitive: true,
    summary: 'Approve a pending join request (admin only).',
    body: { user_id: str('Requesting user id') }, required: ['user_id'],
  },
  groups_delete: { method: 'DELETE', path: 'groups/{group}', params: ['group'], sensitive: true, confirm: true, summary: 'Delete an empty group the user owns (blocked if it has money activity).' },

  // ── Members ───────────────────────────────────────────────────
  members_make_admin: { method: 'POST', path: 'groups/{group}/members/{member}/make-admin', params: ['group', 'member'], sensitive: true, confirm: true, summary: 'Promote a member to admin (admin only).' },
  members_remove: { method: 'DELETE', path: 'groups/{group}/members/{member}', params: ['group', 'member'], sensitive: true, confirm: true, summary: 'Remove a member from a group (admin only, guarded).' },
  members_leave: { method: 'DELETE', path: 'groups/{group}/leave', params: ['group'], sensitive: true, confirm: true, summary: 'Leave a group (owners cannot leave).' },

  // ── Contributions ─────────────────────────────────────────────
  contributions_list: { method: 'GET', path: 'groups/{group}/contributions', params: ['group'], summary: "List a group's contributions." },
  contributions_start: {
    method: 'POST', path: 'groups/{group}/contributions', params: ['group'], sensitive: true, confirm: true,
    summary: 'Start a mobile-money contribution to a group. State amount + fee and get a yes first.',
    body: { amount: num('Amount to contribute (GHS)') }, required: ['amount'],
  },
  contributions_status: { method: 'GET', path: 'contributions/{contribution}', params: ['contribution'], summary: "Check a contribution's status." },
  contributions_submit_otp: {
    method: 'POST', path: 'contributions/{contribution}/otp', params: ['contribution'], sensitive: true,
    summary: 'Submit the MoMo OTP for a pending contribution.',
    body: { otp: str('Code from the network') }, required: ['otp'],
  },

  // ── Payouts ───────────────────────────────────────────────────
  payouts_list: { method: 'GET', path: 'groups/{group}/payouts', params: ['group'], summary: "List a group's payouts." },
  payouts_propose: {
    method: 'POST', path: 'groups/{group}/payouts', params: ['group'], sensitive: true, confirm: true,
    summary: 'Propose a payout to a member (admin only). Members then vote.',
    body: { recipient_id: str('Recipient member id'), amount: num('Amount') }, required: ['recipient_id', 'amount'],
  },
  payouts_get: { method: 'GET', path: 'payouts/{payout}', params: ['payout'], summary: "Get a payout's detail and quote." },
  payouts_vote: {
    method: 'POST', path: 'payouts/{payout}/vote', params: ['payout'], sensitive: true, confirm: true,
    summary: 'Vote to approve or reject a proposed payout.',
    body: { approve: { type: 'boolean', description: 'true = approve, false = reject' } }, required: ['approve'],
  },
  payouts_retry: { method: 'POST', path: 'payouts/{payout}/retry', params: ['payout'], sensitive: true, confirm: true, summary: 'Retry a failed payout (admin only).' },

  // ── Wallet ────────────────────────────────────────────────────
  wallet_get: { method: 'GET', path: 'wallet', summary: "Get the user's wallet balance (available + reserved)." },
  wallet_transactions: { method: 'GET', path: 'wallet/transactions', summary: 'List wallet ledger entries.' },
  wallet_topup_quote: { method: 'POST', path: 'wallet/topups/quote', summary: 'Quote the fee to add money to the wallet.', body: { amount: num('Amount to add') }, required: ['amount'] },
  wallet_topup: { method: 'POST', path: 'wallet/topups', sensitive: true, confirm: true, summary: 'Add money to the wallet via mobile money. State the fee first.', body: { amount: num('Amount to add') }, required: ['amount'] },
  wallet_topup_status: { method: 'GET', path: 'wallet/topups/{walletTopup}', params: ['walletTopup'], summary: "Check a top-up's status." },
  wallet_topup_otp: { method: 'POST', path: 'wallet/topups/{walletTopup}/otp', params: ['walletTopup'], sensitive: true, summary: 'Submit the MoMo OTP for a wallet top-up.', body: { otp: str('Code from the network') }, required: ['otp'] },

  // ── Transfers ─────────────────────────────────────────────────
  transfers_quote: {
    method: 'POST', path: 'transfers/quote',
    summary: 'Quote a money transfer (fees + FX + recipient name).',
    body: transferBody(), required: ['amount', 'destination_country', 'destination_method'],
  },
  transfers_send: {
    method: 'POST', path: 'transfers', sensitive: true, confirm: true,
    summary: 'Send money from the wallet to a recipient. Preview with transfers_quote first and confirm.',
    body: transferBody(), required: ['amount', 'destination_country', 'destination_method'],
  },
  transfers_status: { method: 'GET', path: 'transfers/{directTransfer}', params: ['directTransfer'], summary: "Check a transfer's status." },

  // ── Chat / notifications ──────────────────────────────────────
  chat_conversations: { method: 'GET', path: 'conversations', summary: "List the user's conversations." },
  chat_messages: { method: 'GET', path: 'conversations/{conversation}/messages', params: ['conversation'], summary: 'Read messages in a conversation.' },
  chat_send: {
    method: 'POST', path: 'conversations/{conversation}/messages', params: ['conversation'], sensitive: true,
    summary: "Send a message on the user's behalf into a conversation/group they belong to.",
    body: { body: str('Message text') }, required: ['body'],
  },
  notifications_list: { method: 'GET', path: 'notifications', summary: "List the user's notifications and action items." },
};
