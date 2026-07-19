// Minimal Convex API reference. The connector calls functions by path
// (e.g. api.agent.heartbeat → the "agent:heartbeat" function); anyApi resolves
// these to function references at runtime, so no backend codegen needs to ship
// with the connector.
import { anyApi } from 'convex/server';

export const api = anyApi;
