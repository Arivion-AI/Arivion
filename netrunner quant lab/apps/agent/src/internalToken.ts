import jwt from "jsonwebtoken";

// The agent verifies HS256 owner tokens with the same JWT_SECRET as the Lab. For background work
// with no inbound request (trigger fires, position-monitor exits) we mint a short-lived owner token
// ourselves so the owner-scoped MCP client authenticates exactly like a user-driven call.
export function mintInternalToken(ownerId: number): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required");
  return jwt.sign({ sub: String(ownerId), ver: 0 }, secret, { expiresIn: "10m" });
}
