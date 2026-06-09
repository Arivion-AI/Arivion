export const NETRUNNERS_PROXY_PREFIX = "/api/netrunners";

export const runtimeNetrunnersConfig = {
  baseUrl: process.env.NETRUNNERS_API_URL ?? "http://localhost:4400",
  ownerId: process.env.NETRUNNERS_OWNER_ID ?? "1",
  staticToken: process.env.NETRUNNERS_API_TOKEN,
};
