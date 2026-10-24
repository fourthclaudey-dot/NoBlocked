// Lazy lookups of Discord internals. Modules are resolved on first use so a missing
// module (e.g. after a Discord update) only disables the feature that needs it.
const { metro } = vendetta;

function lazy<T>(get: () => T): () => T {
    let cached: T | undefined;
    return () => (cached ??= get());
}

export const FluxDispatcher = metro.common.FluxDispatcher;

export const RelationshipStore = lazy(() => metro.findByStoreName("RelationshipStore"));
export const MessageStore = lazy(() => metro.findByStoreName("MessageStore"));
export const ReadStateStore = lazy(() => metro.findByStoreName("ReadStateStore"));
export const ChannelStore = lazy(() => metro.findByStoreName("ChannelStore"));
export const SelectedChannelStore = lazy(() => metro.findByStoreName("SelectedChannelStore"));
export const UserGuildSettingsStore = lazy(() => metro.findByStoreName("UserGuildSettingsStore"));
export const ReferencedMessageStore = lazy(() => metro.findByStoreName("ReferencedMessageStore"));
export const UserStore = lazy(() => metro.findByStoreName("UserStore"));
export const MessageReactionsStore = lazy(() => metro.findByStoreName("MessageReactionsStore"));
export const LocaleStore = lazy(() => metro.findByStoreName("LocaleStore"));
export const GatewayConnectionStore = lazy(() => metro.findByStoreName("GatewayConnectionStore"));

/** Module whose `default` turns ChannelMessages into the rows the native chat list renders. */
export const ChannelStreamModule = lazy(() => metro.findByName("createChannelStream", false));
export const MessageActions = lazy(() => metro.findByProps("fetchMessages", "sendMessage"));
export const AckActions = lazy(() => metro.findByProps("bulkAck", "localAck"));
export const HTTP = lazy(() => metro.findByProps("getAPIBaseURL", "get"));

/** rowType values produced by createChannelStream on Discord Android 300.x */
export const RowType = {
    MESSAGE: 1,
    BLOCKED_GROUP: 2,
    IGNORED_GROUP: 6,
} as const;

/** Raw relationship flux events that can change who is blocked/ignored. */
export const RELATIONSHIP_EVENTS = ["RELATIONSHIP_ADD", "RELATIONSHIP_UPDATE", "RELATIONSHIP_REMOVE"];
