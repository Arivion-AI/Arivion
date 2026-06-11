import * as IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
export const redis = new IORedis.Redis(redisUrl, { maxRetriesPerRequest: 2 });
