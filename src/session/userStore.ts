/**
 * In-memory driver store.
 *
 * This is a deliberately small stand-in so the authentication flow is fully
 * functional and testable today; a later ticket is expected to swap this for a
 * real persistence layer. Consumers depend only on the `UserStore` interface,
 * so that swap won't ripple outward.
 */

import { randomUUID } from 'node:crypto';
import { DriverUser } from './types';

export interface UserStore {
  create(user: Omit<DriverUser, 'id' | 'createdAt'>): Promise<DriverUser>;
  findById(id: string): Promise<DriverUser | undefined>;
  findByEmail(email: string): Promise<DriverUser | undefined>;
  update(user: DriverUser): Promise<DriverUser>;
}

export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, DriverUser>();
  private readonly emailIndex = new Map<string, string>();

  async create(user: Omit<DriverUser, 'id' | 'createdAt'>): Promise<DriverUser> {
    const email = normalizeEmail(user.email);
    if (this.emailIndex.has(email)) {
      throw new Error(`A driver with email ${user.email} already exists`);
    }

    const record: DriverUser = {
      ...user,
      email,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.byId.set(record.id, record);
    this.emailIndex.set(email, record.id);
    return { ...record };
  }

  async findById(id: string): Promise<DriverUser | undefined> {
    const record = this.byId.get(id);
    return record ? { ...record } : undefined;
  }

  async findByEmail(email: string): Promise<DriverUser | undefined> {
    const id = this.emailIndex.get(normalizeEmail(email));
    return id ? this.findById(id) : undefined;
  }

  async update(user: DriverUser): Promise<DriverUser> {
    if (!this.byId.has(user.id)) {
      throw new Error(`Cannot update unknown driver ${user.id}`);
    }
    const record = { ...user, email: normalizeEmail(user.email) };
    this.byId.set(record.id, record);
    this.emailIndex.set(record.email, record.id);
    return { ...record };
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
