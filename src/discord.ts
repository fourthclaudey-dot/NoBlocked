// Discord internals used by the plugin, looked up lazily: a module renamed by a Discord update
// then only disables the feature that needs it.
const { metro } = vendetta;

function lazy<T>(get: () => T): () => T {
    let cached: T | undefined;
    return () => (cached ??= get());
}

const store = <T = any>(name: string) => lazy<T>(() => metro.findByStoreName(name));

// ---- the parts of Discord's stores the plugin calls (records stay `any`: they are Discord's) ----

interface FluxStore {
    emitChange(): void;
    addChangeListener(fn: () => void): void;
    removeChangeListener(fn: () => void): void;
}

/** A chat's loaded messages, oldest first. */
export interface ChannelMessages {
    toArray(): any[];
    hasMoreAfter: boolean;
    loadingMore: boolean;
    revealedMessageId: string | null;
}

interface MessageStoreT extends FluxStore {
    getMessages(channelId: string): ChannelMessages | undefined;
    getMessage(channelId: string, messageId: string): any;
}

interface ReadStateStoreT extends FluxStore {
    getAllReadStates(): any[];
    hasUnread(channelId: string): boolean;
    getUnreadCount(channelId: string): number;
    getMentionCount(channelId: string): number;
    isEstimated(channelId: string): boolean;
    lastMessageId(channelId: string): string | null;
    ackMessageId(channelId: string): string | null;
    getOldestUnreadMessageId(channelId: string): string | null;
    getOldestUnreadTimestamp(channelId: string): number;
}

interface RelationshipStoreT extends FluxStore {
    getBlockedIDs(): string[];
    getIgnoredIDs(): string[];
}

interface ChannelStoreT extends FluxStore {
    getChannel(channelId: string): any;
    getBasicChannel?(channelId: string): any;
    getAllThreadsForGuild?(guildId: string): any;
    getAllThreadsForParent?(channelId: string): any;
}

export const { FluxDispatcher } = metro.common;

export const ChannelStore = store<ChannelStoreT>("ChannelStore");
export const GatewayConnectionStore = store<{ isConnected(): boolean }>("GatewayConnectionStore");
export const GuildChannelStore = store<{ getChannels(guildId: string): Record<string, any> }>("GuildChannelStore");
export const GuildStore = store<{ getGuildIds?(): string[]; getGuilds?(): Record<string, any> }>("GuildStore");
export const LocaleStore = store<{ locale: string }>("LocaleStore");
export const MessageReactionsStore = store<{ getReactions(...args: any[]): Map<string, any> }>("MessageReactionsStore");
export const MessageStore = store<MessageStoreT>("MessageStore");
export const ReadStateStore = store<ReadStateStoreT>("ReadStateStore");
export const ReferencedMessageStore = store<{ getMessageByReference(ref: any): { message?: any } | undefined }>("ReferencedMessageStore");
export const RelationshipStore = store<RelationshipStoreT>("RelationshipStore");
export const SelectedChannelStore = store<{ getChannelId(): string | undefined }>("SelectedChannelStore");
export const ThreadMessageStore = store<FluxStore & { getCount(threadId: string): number }>("ThreadMessageStore");
export const UserGuildSettingsStore = store<{ isGuildOrCategoryOrChannelMuted(guildId: string, channelId: string): boolean }>("UserGuildSettingsStore");
export const UserStore = store<{ getCurrentUser(): any; getUser(userId: string): any }>("UserStore");

/** Module whose `default` turns ChannelMessages into the rows the native chat list renders. */
export const ChannelStreamModule = lazy(() => metro.findByName("createChannelStream", false));
export const MessageActions = lazy(() => metro.findByProps("fetchMessages", "sendMessage"));
export const AckActions = lazy(() => metro.findByProps("bulkAck", "localAck"));
export const HTTP = lazy(() => metro.findByProps("getAPIBaseURL", "get"));

/** The dispatcher's store nodes ({ name, actionHandler }): an object in Discord 300.x, a Map since 350.x. */
export function storeNodes(): any[] | null {
    const handlers = FluxDispatcher._actionHandlers;
    const nodes = handlers?._dependencyGraph?.nodes ?? handlers?._nodes;
    if (!nodes) return null;
    return nodes instanceof Map ? [...nodes.values()] : Object.values(nodes);
}

/** rowType values produced by createChannelStream (Discord Android 300.x–350.x). */
export const RowType = {
    MESSAGE: 1,
    BLOCKED_GROUP: 2,
    IGNORED_GROUP: 6,
    DAY: "day",
    UNREAD: "unread",
    LOAD_BEFORE: "load_before",
} as const;

/** Raw relationship flux events that can change who is blocked/ignored. */
export const RELATIONSHIP_EVENTS = ["RELATIONSHIP_ADD", "RELATIONSHIP_UPDATE", "RELATIONSHIP_REMOVE"];
