const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function safeKey(key) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.split('/').some(p => p === '..' || p === '.')) throw new Error('Invalid storage key');
  return key;
}

class LocalStore {
  constructor(root) { this.root = path.resolve(root); }
  async get(key) {
    try { return await fs.readFile(path.join(this.root, safeKey(key))); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  async put(key, body) {
    const dest = path.join(this.root, safeKey(key));
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const temporary = `${dest}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, body, { mode: 0o600 }); await fs.rename(temporary, dest); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async delete(key) { await fs.rm(path.join(this.root, safeKey(key)), { force: true }); }
  async list(prefix = '') {
    const result = [];
    const walk = async dir => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (err) { if (err.code === 'ENOENT') return; throw err; }
      for (const entry of entries) {
        const filename = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(filename);
        else if (entry.isFile()) {
          const key = path.relative(this.root, filename).split(path.sep).join('/');
          if (key.startsWith(prefix)) result.push({ key, modified: (await fs.stat(filename)).mtimeMs });
        }
      }
    };
    await walk(this.root);
    return result;
  }
}

class S3Store {
  constructor(env) {
    const sdk = require('@aws-sdk/client-s3');
    for (const name of ['AWS_ENDPOINT_URL', 'AWS_S3_BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      if (!env[name]) throw new Error(`Missing ${name}`);
    }
    this.sdk = sdk;
    this.bucket = env.AWS_S3_BUCKET_NAME;
    this.client = new sdk.S3Client({
      endpoint: env.AWS_ENDPOINT_URL, region: env.AWS_DEFAULT_REGION || 'auto',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    });
  }
  async get(key) {
    try {
      const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) { if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null; throw err; }
  }
  async put(key, body, contentType = 'application/json') {
    await this.client.send(new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: body, ContentType: contentType, CacheControl: 'no-store' }));
  }
  async delete(key) { await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) })); }
  async list(prefix = '') {
    const entries = [];
    let token;
    do {
      const res = await this.client.send(new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of res.Contents || []) entries.push({ key: object.Key, modified: object.LastModified.getTime() });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return entries;
  }
}

function publishedStore(env = process.env) {
  if (env.STORAGE_BACKEND === 's3') return new S3Store(env);
  if (env.RAILWAY_ENVIRONMENT_ID) throw new Error('Railway requires STORAGE_BACKEND=s3');
  return new LocalStore(env.PUBLISHED_DIR || path.join(__dirname, '..', '.runtime', 'published'));
}
async function readJson(store, key) {
  const bytes = await store.get(key);
  return bytes ? JSON.parse(bytes.toString('utf8')) : null;
}
async function writeJson(store, key, data) { await store.put(key, JSON.stringify(data)); }
module.exports = { LocalStore, S3Store, publishedStore, readJson, writeJson };
