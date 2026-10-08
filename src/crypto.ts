import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Envelope = { v: 1; iv: string; tag: string; ct: string };

/** AES-256-GCM with a local master key (0600 file). Protects the vault at rest and in backups. */
export class Sealer {
  private constructor(private key: Buffer) {}

  static fromHome(home: string, keyHex = process.env.INSTINCT_MASTER_KEY) {
    if (keyHex) {
      if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('INSTINCT_MASTER_KEY must be 64 hex characters');
      return new Sealer(Buffer.from(keyHex, 'hex'));
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = join(home, 'master.key');
    if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return new Sealer(Buffer.from(readFileSync(path, 'utf8').trim(), 'hex'));
  }

  static forTests() {
    return new Sealer(randomBytes(32));
  }

  seal(value: unknown, aad: string): Envelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  open<T>(envelope: Envelope, aad: string): T {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }
}

