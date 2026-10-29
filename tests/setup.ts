import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { resetDbHandle } from '../utils/db/schema';

// 每个用例一个全新的数据库实例，避免用例之间互相污染
beforeEach(() => {
  resetDbHandle();
  globalThis.indexedDB = new IDBFactory();
});
