import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
  now?: () => number;
};

const MAX_LOGIN_ATTEMPTS_PER_WINDOW = 10;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED_LOGIN_CLIENTS = 10_000;

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

/**
 * Counts sign-in attempts per client address. An attempt is counted before its
 * password is checked, so a burst of parallel guesses cannot all slip past the
 * limit while bcrypt is still busy; a successful sign-in clears the count.
 */
function createLoginAttemptTracker(now: () => number) {
  const attemptsByClient = new Map<string, number[]>();

  const recentAttempts = (clientKey: string): number[] => {
    const windowStart = now() - LOGIN_ATTEMPT_WINDOW_MS;
    const recent = (attemptsByClient.get(clientKey) ?? []).filter((attemptedAt) => attemptedAt > windowStart);
    if (recent.length === 0) {
      attemptsByClient.delete(clientKey);
    } else {
      attemptsByClient.set(clientKey, recent);
    }
    return recent;
  };

  return {
    retryAfterSeconds(clientKey: string): number {
      const recent = recentAttempts(clientKey);
      if (recent.length < MAX_LOGIN_ATTEMPTS_PER_WINDOW) {
        return 0;
      }
      return Math.max(1, Math.ceil((recent[0] + LOGIN_ATTEMPT_WINDOW_MS - now()) / 1000));
    },
    recordAttempt(clientKey: string): void {
      if (attemptsByClient.size >= MAX_TRACKED_LOGIN_CLIENTS) {
        for (const trackedClient of [...attemptsByClient.keys()]) {
          recentAttempts(trackedClient);
        }
      }
      attemptsByClient.set(clientKey, [...recentAttempts(clientKey), now()]);
    },
    clear(clientKey: string): void {
      attemptsByClient.delete(clientKey);
    },
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  const loginAttempts = createLoginAttemptTracker(dependencies.now ?? Date.now);

  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      const rejectWhenConfigured = () => {
        if (dependencies.users.hasUsers()) {
          throw new AppError('User already exists. This is a single-user system.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }
      };

      rejectWhenConfigured();
      // Hashed before BEGIN: an await inside the transaction would let a second
      // register request interleave on the shared connection and create a second user.
      const passwordHash = await dependencies.hashPassword(password);
      dependencies.transaction.begin();
      try {
        rejectWhenConfigured();

        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown, clientKey: string) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const retryAfterSeconds = loginAttempts.retryAfterSeconds(clientKey);
      if (retryAfterSeconds > 0) {
        throw new AppError(
          `Too many sign-in attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} min.`,
          { code: 'AUTH_TOO_MANY_ATTEMPTS', statusCode: 429, details: { retryAfterSeconds } },
        );
      }
      loginAttempts.recordAttempt(clientKey);

      const user = dependencies.users.getUserByUsername(username);
      // An unknown username still costs one bcrypt round, so response time does not reveal which names exist.
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : await dependencies.hashPassword(password).then(() => false);
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      loginAttempts.clear(clientKey);
      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
