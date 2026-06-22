export interface DecodedIdTokenClaims {
  uid: string | null;
  name: string | null;
  email: string | null;
  exp?: number;
}

/** Decode JWT payload without verification. Uses "userId" (Ensemble) or "sub" (Firebase) for uid, and "email". */
export function decodeIdTokenClaims(idToken: string): DecodedIdTokenClaims {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return { uid: null, name: null, email: null };
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const decoded = JSON.parse(payload) as {
      userId?: string;
      sub?: string;
      name?: string;
      email?: string;
      exp?: number;
    };
    const uid =
      typeof decoded.userId === 'string'
        ? decoded.userId
        : typeof decoded.sub === 'string'
          ? decoded.sub
          : null;
    return {
      uid,
      name: typeof decoded.name === 'string' ? decoded.name : null,
      email: typeof decoded.email === 'string' ? decoded.email : null,
      exp: typeof decoded.exp === 'number' ? decoded.exp : undefined,
    };
  } catch {
    return { uid: null, name: null, email: null };
  }
}

export function getIdTokenExpiryMs(idToken: string): number | undefined {
  const { exp } = decodeIdTokenClaims(idToken);
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

export function isTokenExpired(idToken: string, bufferSeconds = 60): boolean {
  const expiry = getIdTokenExpiryMs(idToken);
  if (expiry === undefined) return true;
  return expiry <= Date.now() + bufferSeconds * 1000;
}
