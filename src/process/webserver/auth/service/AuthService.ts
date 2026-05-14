/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { AuthUser } from '../repository/UserRepository';
import { UserRepository } from '../repository/UserRepository';
import { AUTH_CONFIG } from '../../config/constants';

interface TokenPayload {
  userId: string;
  username: string;
  tokenId: string;
  iat?: number;
  exp?: number;
}

type RawTokenPayload = Omit<TokenPayload, 'userId'> & {
  userId: string | number;
};

interface UserCredentials {
  username: string;
  password: string;
  createdAt: number;
}

const hashPasswordAsync = (password: string, saltRounds: number): Promise<string> =>
  new Promise((resolve, reject) => {
    bcrypt.hash(password, saltRounds, (error, hash) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(hash);
    });
  });

const comparePasswordAsync = (password: string, hash: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (error, same) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(same);
    });
  });

const DUMMY_BCRYPT_PASSWORD = 'wayland-auth-dummy-password';
const DUMMY_BCRYPT_HASH = '$2a$12$s5cKddFA1hp06nhAubmZa.eT3/xT9Bmve36cul7fZ6ch2mz9EITDu';

/**
 * Authentication Service - handles password hashing, token issuance, and validation
 */
export class AuthService {
  private static readonly SALT_ROUNDS = 12;
  private static jwtSecret: string | null = null;
  private static readonly TOKEN_EXPIRY = AUTH_CONFIG.TOKEN.SESSION_EXPIRY;

  /**
   * Token blacklist - stores logged out tokens (in-memory, cleared on restart)
   * Key: SHA-256 hash of the token; Value: expiry timestamp
   */
  private static tokenBlacklist: Map<string, number> = new Map();
  private static readonly BLACKLIST_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  private static blacklistCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Add token to blacklist (called on logout)
   */
  public static blacklistToken(token: string): void {
    // Use the token hash as key to avoid storing the raw token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Parse token to get expiry
    try {
      const decoded = jwt.decode(token) as { exp?: number } | null;
      const expiry = decoded?.exp ? decoded.exp * 1000 : Date.now() + AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE;
      this.tokenBlacklist.set(tokenHash, expiry);

      // Start the cleanup timer if not already running
      this.startBlacklistCleanup();
    } catch {
      // Even if parsing fails, add to blacklist (using default expiry)
      this.tokenBlacklist.set(tokenHash, Date.now() + AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE);
    }
  }

  /**
   * Check if token is blacklisted
   */
  public static isTokenBlacklisted(token: string): boolean {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiry = this.tokenBlacklist.get(tokenHash);

    if (!expiry) {
      return false;
    }

    // If expired, remove from blacklist
    if (Date.now() > expiry) {
      this.tokenBlacklist.delete(tokenHash);
      return false;
    }

    return true;
  }

  /**
   * Start blacklist cleanup timer
   */
  private static startBlacklistCleanup(): void {
    if (this.blacklistCleanupTimer) {
      return;
    }

    this.blacklistCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [hash, expiry] of this.tokenBlacklist.entries()) {
        if (now > expiry) {
          this.tokenBlacklist.delete(hash);
        }
      }
    }, this.BLACKLIST_CLEANUP_INTERVAL);

    // Allow the process to exit normally
    this.blacklistCleanupTimer.unref();
  }

  /**
   * Generate a high-entropy random secret key
   */
  private static generateSecretKey(): string {
    // Always rely on randomness for unpredictability
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Load or create the JWT secret and cache it in memory
   *
   * JWT secret is stored in the admin user's row in users table
   */
  public static async getJwtSecret(): Promise<string> {
    if (this.jwtSecret) {
      return this.jwtSecret;
    }

    // Prefer env var for deploy-time override
    if (process.env.JWT_SECRET) {
      this.jwtSecret = process.env.JWT_SECRET;
      return this.jwtSecret;
    }

    try {
      // Read jwt_secret from admin user in database
      const systemUser = await UserRepository.getPrimaryWebUIUser();
      if (systemUser && systemUser.jwt_secret) {
        this.jwtSecret = systemUser.jwt_secret;
        return this.jwtSecret;
      }

      // Generate new secret and save to admin user
      if (systemUser) {
        const newSecret = this.generateSecretKey();
        await UserRepository.updateJwtSecret(systemUser.id, newSecret);
        this.jwtSecret = newSecret;
        return this.jwtSecret;
      }

      // Fallback: if admin user does not exist (should not happen)
      console.warn('[AuthService] System WebUI user not found, using temporary secret');
      this.jwtSecret = this.generateSecretKey();
      return this.jwtSecret;
    } catch (error) {
      console.error('Failed to get/save JWT secret:', error);
      this.jwtSecret = this.generateSecretKey();
      return this.jwtSecret;
    }
  }

  /**
   * Rotate the JWT secret to invalidate all existing tokens
   */
  public static async invalidateAllTokens(): Promise<void> {
    try {
      const systemUser = await UserRepository.getPrimaryWebUIUser();
      if (!systemUser) {
        console.warn('[AuthService] System WebUI user not found, cannot invalidate tokens');
        return;
      }

      const newSecret = this.generateSecretKey();
      await UserRepository.updateJwtSecret(systemUser.id, newSecret);
      this.jwtSecret = newSecret;
    } catch (error) {
      console.error('Failed to invalidate tokens:', error);
    }
  }

  /**
   * Hash password using bcrypt
   */
  public static hashPassword(password: string): Promise<string> {
    return hashPasswordAsync(password, this.SALT_ROUNDS);
  }

  /**
   * Verify whether the password matches the stored hash
   */
  public static verifyPassword(password: string, hash: string): Promise<boolean> {
    return comparePasswordAsync(password, hash);
  }

  /**
   * Generate standard WebUI session token
   */
  public static async generateToken(user: Pick<AuthUser, 'id' | 'username'>): Promise<string> {
    const payload: TokenPayload = {
      userId: user.id,
      username: user.username,
      tokenId: crypto.randomUUID(),
    };

    return jwt.sign(payload, await this.getJwtSecret(), {
      expiresIn: this.TOKEN_EXPIRY,
      issuer: 'wayland',
      audience: 'wayland-webui',
    });
  }

  /**
   * Normalize database user id into a consistent string
   *
   * Note: In new architecture, all user IDs are already strings (e.g., "auth_1234567890_abc").
   * This function simply ensures the ID is a string type.
   */
  private static normalizeUserId(rawId: string | number): string {
    return String(rawId);
  }

  /**
   * Verify standard WebUI session token validity
   */
  public static async verifyToken(token: string): Promise<TokenPayload | null> {
    try {
      // Check blacklist first
      if (this.isTokenBlacklisted(token)) {
        return null;
      }

      const decoded = jwt.verify(token, await this.getJwtSecret(), {
        issuer: 'wayland',
        audience: 'wayland-webui',
      }) as RawTokenPayload;

      return {
        ...decoded,
        userId: this.normalizeUserId(decoded.userId),
      };
    } catch (error) {
      if (
        error instanceof jwt.TokenExpiredError ||
        error instanceof jwt.JsonWebTokenError ||
        error instanceof jwt.NotBeforeError
      ) {
        return null;
      }
      console.error('Token verification failed:', error);
      return null;
    }
  }

  /**
   * Verify WebSocket token
   *
   * Reuses the Web login token (audience: wayland-webui).
   *
   * @param token - JWT token string
   * @returns Token payload if valid, null otherwise
   */
  public static async verifyWebSocketToken(token: string): Promise<TokenPayload | null> {
    try {
      // Check blacklist first
      if (this.isTokenBlacklisted(token)) {
        return null;
      }

      const decoded = jwt.verify(token, await this.getJwtSecret(), {
        issuer: 'wayland',
        audience: 'wayland-webui', // Use the same audience as Web login
      }) as RawTokenPayload;

      return {
        ...decoded,
        userId: this.normalizeUserId(decoded.userId),
      };
    } catch (error) {
      // TokenExpiredError is expected when sessions naturally expire (24h TTL).
      // Only log unexpected verification failures at error level.
      if (error instanceof jwt.TokenExpiredError) {
        return null;
      }
      console.error('WebSocket token verification failed:', error);
      return null;
    }
  }

  /**
   * Refresh a session token without enforcing expiry check
   */
  public static async refreshToken(token: string): Promise<string | null> {
    if (this.isTokenBlacklisted(token)) {
      return null;
    }

    let decoded: RawTokenPayload;

    try {
      decoded = jwt.verify(token, await this.getJwtSecret(), {
        issuer: 'wayland',
        audience: 'wayland-webui',
        ignoreExpiration: true,
      }) as RawTokenPayload;
    } catch (error) {
      if (
        error instanceof jwt.TokenExpiredError ||
        error instanceof jwt.JsonWebTokenError ||
        error instanceof jwt.NotBeforeError
      ) {
        return null;
      }

      console.error('Token refresh verification failed:', error);
      return null;
    }

    this.blacklistToken(token);

    // Skip expiry check when refreshing token
    return this.generateToken({
      id: this.normalizeUserId(decoded.userId),
      username: decoded.username,
    });
  }

  /**
   * Generate a random password with required complexity
   */
  public static generateRandomPassword(): string {
    const baseLength = 12;
    const lengthVariance = 5;
    const passwordLength = baseLength + crypto.randomInt(0, lengthVariance);

    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const special = '!@#$%^&*';
    const allChars = lowercase + uppercase + digits + special;

    const ensureCategory = (chars: string) => chars[crypto.randomInt(0, chars.length)];

    const passwordChars: string[] = [
      ensureCategory(lowercase),
      ensureCategory(uppercase),
      ensureCategory(digits),
      ensureCategory(special),
    ];

    const remainingLength = Math.max(passwordLength - passwordChars.length, 0);
    for (let i = 0; i < remainingLength; i++) {
      const index = crypto.randomInt(0, allChars.length);
      passwordChars.push(allChars[index]);
    }

    // Shuffle to avoid predictable category order
    for (let i = passwordChars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [passwordChars[i], passwordChars[j]] = [passwordChars[j], passwordChars[i]];
    }

    return passwordChars.join('');
  }

  /**
   * Generate random credentials for initial bootstrap
   */
  public static generateUserCredentials(): UserCredentials {
    // Username length fixed to 6-8 chars for memorability
    const usernameLength = crypto.randomInt(6, 9); // 6-8 chars
    const usernameChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let username = '';
    for (let i = 0; i < usernameLength; i++) {
      username += usernameChars[crypto.randomInt(0, usernameChars.length)];
    }

    return {
      username,
      password: this.generateRandomPassword(),
      createdAt: Date.now(),
    };
  }

  /**
   * Validate password strength (simplified for local WebUI)
   */
  public static validatePasswordStrength(password: string): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Only require minimum length
    if (password.length < 8) {
      errors.push('PASSWORD_TOO_SHORT');
    }

    if (password.length > 128) {
      errors.push('PASSWORD_TOO_LONG');
    }

    // Block obvious weak passwords
    const weakPasswords = ['password', '12345678', '123456789', 'qwertyui', 'abcdefgh'];
    if (weakPasswords.includes(password.toLowerCase())) {
      errors.push('PASSWORD_TOO_COMMON');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate username format requirements
   */
  public static validateUsername(username: string): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (username.length < 3) {
      errors.push('Username must be at least 3 characters long');
    }

    if (username.length > 32) {
      errors.push('Username must be less than 32 characters long');
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      errors.push('Username can only contain letters, numbers, hyphens, and underscores');
    }

    if (/^[_-]|[_-]$/.test(username)) {
      errors.push('Username cannot start or end with hyphen or underscore');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Generate a high-entropy session identifier
   */
  public static generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Perform constant-time comparison to mitigate timing attacks
   */
  public static async constantTimeVerify(provided: string, expected: string, hashProvided = false): Promise<boolean> {
    // Ensure constant-time comparison routine
    const start = process.hrtime.bigint();

    let result: boolean;
    if (hashProvided) {
      result = await comparePasswordAsync(provided, expected);
    } else {
      result = crypto.timingSafeEqual(
        Buffer.from(provided.padEnd(expected.length, '0')),
        Buffer.from(expected.padEnd(provided.length, '0'))
      );
    }

    // Add minimum delay to prevent timing attacks
    const elapsed = process.hrtime.bigint() - start;
    const minDelay = BigInt(50_000_000); // 50ms in nanoseconds
    if (elapsed < minDelay) {
      const delayMs = Number((minDelay - elapsed) / BigInt(1_000_000));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    return result;
  }

  /**
   * Perform a real bcrypt verification for missing users to avoid username-enumeration timing differences
   */
  public static async constantTimeVerifyMissingUser(): Promise<boolean> {
    return this.constantTimeVerify(DUMMY_BCRYPT_PASSWORD, DUMMY_BCRYPT_HASH, true);
  }
}

export default AuthService;
