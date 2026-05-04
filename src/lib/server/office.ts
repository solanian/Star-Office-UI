import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import mime from 'mime';
import sharp from 'sharp';
import type { RequestEvent } from '@sveltejs/kit';

type JsonObject = Record<string, unknown>;

type AgentState = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error';

type AgentRecord = {
  agentId: string;
  name: string;
  isMain: boolean;
  state: AgentState;
  detail: string;
  updated_at: string;
  area: string;
  source: string;
  joinKey: string | null;
  authStatus: 'approved' | 'pending' | 'rejected' | 'offline';
  authExpiresAt: string | null;
  authApprovedAt?: string;
  authRejectedAt?: string;
  lastPushAt: string | null;
  avatar?: string;
};

type JoinKeyRecord = {
  key: string;
  used?: boolean;
  reusable?: boolean;
  maxConcurrent?: number;
  usedBy?: string | null;
  usedByAgentId?: string | null;
  usedAt?: string | null;
  expiresAt?: string;
};

type JoinKeys = { keys: JoinKeyRecord[] };

const rootDir = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.STAR_OFFICE_DATA_DIR || rootDir);
const frontendDir = path.join(rootDir, 'frontend');
const frontendPath = path.resolve(frontendDir);
const memoryDir = process.env.STAR_OFFICE_MEMORY_DIR
  ? path.resolve(process.env.STAR_OFFICE_MEMORY_DIR)
  : path.resolve(rootDir, '..', 'memory');
const openclawWorkspace = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || '', '.openclaw', 'workspace');
const identityFile = path.join(openclawWorkspace, 'IDENTITY.md');

const stateFile = path.join(dataDir, 'state.json');
const agentsStateFile = path.join(dataDir, 'agents-state.json');
const joinKeysFile = path.join(dataDir, 'join-keys.json');
const assetPositionsFile = path.join(dataDir, 'asset-positions.json');
const assetDefaultsFile = path.join(dataDir, 'asset-defaults.json');
const runtimeConfigFile = path.join(dataDir, 'runtime-config.json');

const bgHistoryDir = path.join(rootDir, 'assets', 'bg-history');
const homeFavoritesDir = path.join(rootDir, 'assets', 'home-favorites');
const homeFavoritesIndexFile = path.join(homeFavoritesDir, 'index.json');
const roomReferenceImage = existsSync(path.join(rootDir, 'assets', 'room-reference.webp'))
  ? path.join(rootDir, 'assets', 'room-reference.webp')
  : path.join(rootDir, 'assets', 'room-reference.png');

const versionTimestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 15);
const assetDrawerPass = process.env.ASSET_DRAWER_PASS || '1234';
const assetAllowedExts = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg', '.avif']);
const validStates = new Set<AgentState>(['idle', 'writing', 'researching', 'executing', 'syncing', 'error']);
const workingStates = new Set<AgentState>(['writing', 'researching', 'executing']);

const bgTasks = new Map<string, { status: 'pending' | 'done' | 'error'; result?: JsonObject; created_at?: string }>();

const defaultState = () => ({
  state: 'idle',
  detail: '等待任务中...',
  progress: 0,
  updated_at: new Date().toISOString()
});

const defaultAgents = (): AgentRecord[] => [
  {
    agentId: 'star',
    name: 'Star',
    isMain: true,
    state: 'idle',
    detail: '待命中，随时准备为你服务',
    updated_at: new Date().toISOString(),
    area: 'breakroom',
    source: 'local',
    joinKey: null,
    authStatus: 'approved',
    authExpiresAt: null,
    lastPushAt: null
  }
];

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
      ...headers
    }
  });
}

function html(text: string, status = 200) {
  return new Response(text.replaceAll('{{VERSION_TIMESTAMP}}', versionTimestamp), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0'
    }
  });
}

function noCacheHeaders(contentType?: string) {
  const h = new Headers();
  if (contentType) h.set('content-type', contentType);
  h.set('cache-control', 'no-cache, no-store, must-revalidate, max-age=0');
  h.set('pragma', 'no-cache');
  h.set('expires', '0');
  return h;
}

async function ensureParent(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown) {
  await ensureParent(file);
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export function normalizeAgentState(value: unknown): AgentState {
  const s = String(value || '').trim().toLowerCase();
  if (['working', 'busy', 'write'].includes(s)) return 'writing';
  if (['run', 'running', 'execute', 'exec'].includes(s)) return 'executing';
  if (s === 'sync') return 'syncing';
  if (['research', 'search'].includes(s)) return 'researching';
  return validStates.has(s as AgentState) ? (s as AgentState) : 'idle';
}

export function stateToArea(state: AgentState) {
  if (state === 'idle') return 'breakroom';
  if (state === 'error') return 'error';
  return 'writing';
}

async function loadState(): Promise<JsonObject> {
  const state = await readJson<JsonObject>(stateFile, defaultState());
  if (typeof state !== 'object' || state === null) return defaultState();

  try {
    const s = normalizeAgentState(state.state);
    const ttl = Number(state.ttl_seconds ?? 300);
    const updated = typeof state.updated_at === 'string' ? Date.parse(state.updated_at) : NaN;
    if (workingStates.has(s) && Number.isFinite(updated) && Date.now() - updated > ttl * 1000) {
      state.state = 'idle';
      state.detail = '待命中（自动回到休息区）';
      state.progress = 0;
      state.updated_at = new Date().toISOString();
      await writeJson(stateFile, state);
    }
  } catch {
    // Keep state readable even if stale parsing fails.
  }
  return state;
}

async function saveState(state: JsonObject) {
  await writeJson(stateFile, state);
}

async function getOfficeNameFromIdentity() {
  try {
    const content = await readFile(identityFile, 'utf8');
    const match = content.match(/-\s*\*\*Name:\*\*\s*(.+)/);
    const name = match?.[1]?.trim().split(/\r?\n/)[0]?.trim();
    return name ? `${name}的办公室` : null;
  } catch {
    return null;
  }
}

async function loadAgents() {
  const agents = await readJson<AgentRecord[]>(agentsStateFile, defaultAgents());
  if (!Array.isArray(agents) || agents.length === 0) return defaultAgents();
  return agents;
}

async function saveAgents(agents: AgentRecord[]) {
  await writeJson(agentsStateFile, agents);
}

async function loadJoinKeys(): Promise<JoinKeys> {
  if (!existsSync(joinKeysFile)) {
    const samplePath = path.join(rootDir, 'join-keys.sample.json');
    const sample = await readJson<JoinKeys>(samplePath, { keys: [] });
    await writeJson(joinKeysFile, sample);
    return sample;
  }
  const data = await readJson<JoinKeys>(joinKeysFile, { keys: [] });
  return Array.isArray(data.keys) ? data : { keys: [] };
}

async function saveJoinKeys(data: JoinKeys) {
  await writeJson(joinKeysFile, data);
}

function ageSeconds(iso?: string | null) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : null;
}

function randomAvatar() {
  return `guest_role_${Math.floor(Math.random() * 6) + 1}`;
}

async function requestJson(event: RequestEvent) {
  try {
    const data = await event.request.json();
    return typeof data === 'object' && data !== null ? (data as JsonObject) : null;
  } catch {
    return null;
  }
}

function isAssetAuthed(event: RequestEvent) {
  return event.cookies.get('star_asset_editor_authed') === '1';
}

function requireAssetAuth(event: RequestEvent) {
  if (isAssetAuthed(event)) return null;
  return json({ ok: false, code: 'UNAUTHORIZED', msg: 'Asset editor auth required' }, 401);
}

function safeFrontendPath(relPath: string) {
  const clean = relPath.trim().replace(/^\/+/, '');
  const target = path.resolve(frontendPath, clean);
  if (!target.startsWith(frontendPath + path.sep) && target !== frontendPath) return null;
  return { clean, target };
}

function safeRootPath(relPath: string) {
  const clean = relPath.trim().replace(/^\/+/, '');
  const target = path.resolve(rootDir, clean);
  if (!target.startsWith(rootDir + path.sep) && target !== rootDir) return null;
  return { clean, target };
}

async function sendFile(file: string, cacheStatic = false) {
  try {
    const st = await stat(file);
    if (!st.isFile()) return json({ ok: false, msg: 'not found' }, 404);
    const headers = new Headers();
    headers.set('content-type', mime.getType(file) || 'application/octet-stream');
    if (cacheStatic) {
      headers.set('cache-control', 'public, max-age=31536000, immutable');
    } else {
      headers.set('cache-control', 'no-cache, no-store, must-revalidate, max-age=0');
      headers.set('pragma', 'no-cache');
      headers.set('expires', '0');
    }
    return new Response(createReadStream(file) as unknown as BodyInit, { headers });
  } catch {
    return json({ ok: false, msg: 'not found' }, 404);
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(current, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

async function imageMeta(file: string) {
  try {
    const meta = await sharp(file).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

async function loadMap(file: string) {
  const data = await readJson<Record<string, unknown>>(file, {});
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {};
}

async function saveMap(file: string, data: Record<string, unknown>) {
  await writeJson(file, data);
}

async function ensureHomeFavoritesIndex() {
  await mkdir(homeFavoritesDir, { recursive: true });
  if (!existsSync(homeFavoritesIndexFile)) await writeJson(homeFavoritesIndexFile, { items: [] });
}

async function loadHomeFavorites() {
  await ensureHomeFavoritesIndex();
  const data = await readJson<{ items: Array<Record<string, string>> }>(homeFavoritesIndexFile, { items: [] });
  return Array.isArray(data.items) ? data : { items: [] };
}

async function saveHomeFavorites(data: { items: Array<Record<string, string>> }) {
  await ensureHomeFavoritesIndex();
  await writeJson(homeFavoritesIndexFile, data);
}

async function getYesterdayMemo() {
  const sanitize = (text: string) =>
    text
      .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/sk-[A-Za-z0-9]{16,}/g, '[REDACTED_TOKEN]');
  const extract = (content: string) => sanitize(content).slice(0, 4000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const yesterdayFile = path.join(memoryDir, `${yesterday}.md`);
  try {
    if (existsSync(yesterdayFile)) {
      return { success: true, date: yesterday, memo: extract(await readFile(yesterdayFile, 'utf8')) };
    }
    if (!existsSync(memoryDir)) return { success: false, msg: '没有找到昨日日记' };
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.md`;
    const files = (await readdir(memoryDir))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f !== todayStr)
      .sort()
      .reverse();
    if (files[0]) {
      const date = files[0].replace(/\.md$/, '');
      return { success: true, date, memo: extract(await readFile(path.join(memoryDir, files[0]), 'utf8')) };
    }
    return { success: false, msg: '没有找到昨日日记' };
  } catch (e) {
    return { success: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

async function routePages(pathname: string) {
  if (pathname === '') return html(await readFile(path.join(frontendDir, 'index.html'), 'utf8'));
  if (pathname === 'electron-standalone') {
    const standalone = path.join(frontendDir, 'electron-standalone.html');
    const file = existsSync(standalone) ? standalone : path.join(frontendDir, 'index.html');
    return html(await readFile(file, 'utf8'));
  }
  if (pathname === 'join') return html(await readFile(path.join(frontendDir, 'join.html'), 'utf8'));
  if (pathname === 'invite') return html(await readFile(path.join(frontendDir, 'invite.html'), 'utf8'));
  return null;
}

async function handleAgents() {
  const agents = await loadAgents();
  const keys = await loadJoinKeys();
  const cleaned: AgentRecord[] = [];
  for (const agent of agents) {
    if (agent.isMain) {
      cleaned.push(agent);
      continue;
    }
    if (agent.authStatus === 'pending' && agent.authExpiresAt && Date.now() > Date.parse(agent.authExpiresAt)) {
      const key = keys.keys.find((k) => k.key === agent.joinKey);
      if (key) {
        key.used = false;
        key.usedBy = null;
        key.usedByAgentId = null;
        key.usedAt = null;
      }
      continue;
    }
    if (agent.authStatus === 'approved') {
      const age = ageSeconds(agent.lastPushAt) ?? ageSeconds(agent.updated_at);
      if (age !== null && age > 300) agent.authStatus = 'offline';
    }
    cleaned.push(agent);
  }
  await saveAgents(cleaned);
  await saveJoinKeys(keys);
  return json(cleaned);
}

async function handleJoinAgent(event: RequestEvent) {
  const data = await requestJson(event);
  if (!data || !data.name) return json({ ok: false, msg: '请提供名字' }, 400);
  const name = String(data.name).trim();
  const joinKey = String(data.joinKey || '').trim();
  if (!joinKey) return json({ ok: false, msg: '请提供接入密钥' }, 400);

  const keys = await loadJoinKeys();
  const key = keys.keys.find((k) => k.key === joinKey);
  if (!key) return json({ ok: false, msg: '接入密钥无效' }, 403);
  if (key.expiresAt && Date.now() > Date.parse(key.expiresAt)) {
    return json({ ok: false, msg: '该接入密钥已过期，活动已结束 🎉' }, 403);
  }

  const agents = await loadAgents();
  const existing = agents.find((a) => !a.isMain && a.name === name);
  const maxConcurrent = Number(key.maxConcurrent ?? 3);
  const activeCount = agents.filter((a) => {
    if (a.isMain || a.agentId === existing?.agentId || a.joinKey !== joinKey || a.authStatus !== 'approved') return false;
    const age = ageSeconds(a.lastPushAt) ?? ageSeconds(a.updated_at);
    return age === null || age <= 300;
  }).length;
  if (activeCount >= maxConcurrent) {
    return json({ ok: false, msg: `该接入密钥当前并发已达上限（${maxConcurrent}），请稍后或换另一个 key` }, 429);
  }

  const state = normalizeAgentState(data.state);
  const now = new Date().toISOString();
  let agentId = existing?.agentId;
  if (existing) {
    existing.state = state;
    existing.detail = String(data.detail || '');
    existing.updated_at = now;
    existing.area = stateToArea(state);
    existing.source = 'remote-openclaw';
    existing.joinKey = joinKey;
    existing.authStatus = 'approved';
    existing.authApprovedAt = now;
    existing.authExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    existing.lastPushAt = now;
    existing.avatar ||= randomAvatar();
  } else {
    agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    agents.push({
      agentId,
      name,
      isMain: false,
      state,
      detail: String(data.detail || ''),
      updated_at: now,
      area: stateToArea(state),
      source: 'remote-openclaw',
      joinKey,
      authStatus: 'approved',
      authApprovedAt: now,
      authExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      lastPushAt: now,
      avatar: randomAvatar()
    });
  }
  key.used = true;
  key.reusable = true;
  key.usedBy = name;
  key.usedByAgentId = agentId;
  key.usedAt = now;
  await saveAgents(agents);
  await saveJoinKeys(keys);
  return json({ ok: true, agentId, authStatus: 'approved', nextStep: '已自动批准，立即开始推送状态' });
}

async function handleAgentPush(event: RequestEvent) {
  const data = await requestJson(event);
  if (!data) return json({ ok: false, msg: 'invalid json' }, 400);
  const agentId = String(data.agentId || '').trim();
  const joinKey = String(data.joinKey || '').trim();
  const stateRaw = String(data.state || '').trim();
  if (!agentId || !joinKey || !stateRaw) return json({ ok: false, msg: '缺少 agentId/joinKey/state' }, 400);

  const keys = await loadJoinKeys();
  const key = keys.keys.find((k) => k.key === joinKey);
  if (!key) return json({ ok: false, msg: 'joinKey 无效' }, 403);
  if (key.expiresAt && Date.now() > Date.parse(key.expiresAt)) {
    return json({ ok: false, msg: '该接入密钥已过期，活动已结束 🎉' }, 403);
  }

  const agents = await loadAgents();
  const target = agents.find((a) => !a.isMain && a.agentId === agentId);
  if (!target) return json({ ok: false, msg: 'agent 未注册，请先 join' }, 404);
  if (!['approved', 'offline'].includes(target.authStatus)) {
    return json({ ok: false, msg: 'agent 未获授权，请等待主人批准' }, 403);
  }
  if (target.joinKey !== joinKey) return json({ ok: false, msg: 'joinKey 不匹配' }, 403);

  const state = normalizeAgentState(stateRaw);
  const now = new Date().toISOString();
  target.authStatus = 'approved';
  target.state = state;
  target.detail = String(data.detail || '');
  if (data.name) target.name = String(data.name);
  target.updated_at = now;
  target.area = stateToArea(state);
  target.source = 'remote-openclaw';
  target.lastPushAt = now;
  await saveAgents(agents);
  return json({ ok: true, agentId, area: target.area });
}

async function handleLeaveAgent(event: RequestEvent) {
  const data = await requestJson(event);
  if (!data) return json({ ok: false, msg: 'invalid json' }, 400);
  const agentId = String(data.agentId || '').trim();
  const name = String(data.name || '').trim();
  if (!agentId && !name) return json({ ok: false, msg: '请提供 agentId 或名字' }, 400);
  const agents = await loadAgents();
  const target = agents.find((a) => !a.isMain && (agentId ? a.agentId === agentId : a.name === name));
  if (!target) return json({ ok: false, msg: '没有找到要离开的 agent' }, 404);
  const keys = await loadJoinKeys();
  const key = keys.keys.find((k) => k.key === target.joinKey);
  if (key) {
    key.used = false;
    key.usedBy = null;
    key.usedByAgentId = null;
    key.usedAt = null;
  }
  await saveAgents(agents.filter((a) => a.isMain || a.agentId !== target.agentId));
  await saveJoinKeys(keys);
  return json({ ok: true });
}

async function handleApproveReject(event: RequestEvent, reject: boolean) {
  const data = await requestJson(event);
  const agentId = String(data?.agentId || '').trim();
  if (!agentId) return json({ ok: false, msg: '缺少 agentId' }, 400);
  const agents = await loadAgents();
  const target = agents.find((a) => !a.isMain && a.agentId === agentId);
  if (!target) return json({ ok: false, msg: '未找到 agent' }, 404);
  if (!reject) {
    target.authStatus = 'approved';
    target.authApprovedAt = new Date().toISOString();
    target.authExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await saveAgents(agents);
    return json({ ok: true, agentId, authStatus: 'approved' });
  }
  target.authStatus = 'rejected';
  target.authRejectedAt = new Date().toISOString();
  const keys = await loadJoinKeys();
  const key = keys.keys.find((k) => k.key === target.joinKey);
  if (key) {
    key.used = false;
    key.usedBy = null;
    key.usedByAgentId = null;
    key.usedAt = null;
  }
  await saveAgents(agents.filter((a) => a.isMain || a.agentId !== agentId));
  await saveJoinKeys(keys);
  return json({ ok: true, agentId, authStatus: 'rejected' });
}

async function handleAssetsList() {
  const files = await listFilesRecursive(frontendPath);
  const items = [];
  for (const file of files) {
    const rel = path.relative(frontendPath, file).split(path.sep).join('/');
    const ext = path.extname(file).toLowerCase();
    if (rel.startsWith('fonts/') || !assetAllowedExts.has(ext)) continue;
    const st = await stat(file);
    const meta = await imageMeta(file);
    items.push({ path: rel, size: st.size, ext, width: meta.width, height: meta.height, mtime: st.mtime.toISOString() });
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return json({ ok: true, count: items.length, items });
}

async function handleAssetUpload(event: RequestEvent) {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  const form = await event.request.formData();
  const relPath = String(form.get('path') || '').trim().replace(/^\/+/, '');
  const file = form.get('file');
  if (!relPath || !(file instanceof File)) return json({ ok: false, msg: '缺少 path 或 file' }, 400);
  const safe = safeFrontendPath(relPath);
  if (!safe) return json({ ok: false, msg: '非法 path' }, 400);
  const ext = path.extname(safe.target).toLowerCase();
  if (!assetAllowedExts.has(ext)) return json({ ok: false, msg: '仅允许上传图片/美术资源类型' }, 400);
  if (!existsSync(safe.target)) return json({ ok: false, msg: '目标文件不存在，请先从 /assets/list 选择 path' }, 404);

  const defaultSnap = `${safe.target}.default`;
  if (!existsSync(defaultSnap)) {
    try {
      await copyFile(safe.target, defaultSnap);
    } catch {
      // best-effort snapshot
    }
  }
  if (String(form.get('backup') || '1') !== '0') await copyFile(safe.target, `${safe.target}.bak`);
  await writeFile(safe.target, Buffer.from(await file.arrayBuffer()));
  const st = await stat(safe.target);
  return json({ ok: true, path: safe.clean, size: st.size, backup: String(form.get('backup') || '1') !== '0' });
}

async function restoreAsset(event: RequestEvent, mode: 'default' | 'prev') {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  const data = await requestJson(event);
  const relPath = String(data?.path || '').trim().replace(/^\/+/, '');
  if (!relPath) return json({ ok: false, msg: '缺少 path' }, 400);
  const safe = safeFrontendPath(relPath);
  if (!safe) return json({ ok: false, msg: '非法 path' }, 400);
  if (!existsSync(safe.target)) return json({ ok: false, msg: '目标文件不存在' }, 404);
  const src = mode === 'default' ? `${safe.target}.default` : `${safe.target}.bak`;
  if (!existsSync(src)) return json({ ok: false, msg: mode === 'default' ? '未找到默认资产快照' : '未找到上一版备份' }, 404);
  await copyFile(safe.target, `${safe.target}.bak`);
  await copyFile(src, safe.target);
  const st = await stat(safe.target);
  return json({ ok: true, path: safe.clean, size: st.size, msg: mode === 'default' ? '已重置为默认资产' : '已回退到上一版' });
}

async function handlePositionMap(event: RequestEvent, file: string) {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  if (event.request.method === 'GET') return json({ ok: true, items: await loadMap(file) });
  const data = await requestJson(event);
  const key = String(data?.key || '').trim();
  if (!key) return json({ ok: false, msg: '缺少 key' }, 400);
  if (data?.x === undefined || data.y === undefined) return json({ ok: false, msg: '缺少 x/y' }, 400);
  const x = Number(data.x);
  const y = Number(data.y);
  const scale = data.scale === undefined ? 1 : Number(data.scale);
  const all = await loadMap(file);
  all[key] = { x, y, scale, updated_at: new Date().toISOString() };
  await saveMap(file, all);
  return json({ ok: true, key, x, y, scale });
}

export function normalizeUserModel(model: string) {
  const m = model.trim().toLowerCase();
  if (m === 'nanobanana-2' || m === 'gemini-2.5-flash-image') return 'nanobanana-2';
  return 'nanobanana-pro';
}

async function handleGeminiConfig(event: RequestEvent) {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  if (event.request.method === 'GET') {
    const cfg = await readJson<Record<string, string>>(runtimeConfigFile, {});
    const key = String(cfg.gemini_api_key || '').trim();
    return json({
      ok: true,
      has_api_key: Boolean(key),
      api_key_masked: key ? '*'.repeat(Math.max(0, key.length - 4)) + key.slice(-4) : '',
      gemini_model: normalizeUserModel(String(cfg.gemini_model || 'nanobanana-pro'))
    });
  }
  const data = await requestJson(event);
  const current = await readJson<Record<string, string>>(runtimeConfigFile, {});
  const apiKey = String(data?.api_key || '').trim();
  const model = normalizeUserModel(String(data?.model || 'nanobanana-pro'));
  const next: Record<string, string> = { ...current, gemini_model: model };
  if (apiKey) next.gemini_api_key = apiKey;
  await writeJson(runtimeConfigFile, next);
  return json({ ok: true, msg: 'Gemini 配置已保存' });
}

async function handleGenerateBackground(event: RequestEvent) {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  const cfg = await readJson<Record<string, string>>(runtimeConfigFile, {});
  if (!String(cfg.gemini_api_key || '').trim()) {
    return json({ ok: false, code: 'MISSING_API_KEY', msg: 'Missing GEMINI_API_KEY or GOOGLE_API_KEY' }, 400);
  }
  const taskId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  bgTasks.set(taskId, { status: 'pending', created_at: new Date().toISOString() });
  setTimeout(() => {
    bgTasks.set(taskId, {
      status: 'error',
      result: { ok: false, code: 'MODEL_NOT_AVAILABLE', msg: 'Configured model is not available for this API key/channel.' }
    });
  }, 10);
  return json({ ok: true, async: true, task_id: taskId, msg: '生图任务已启动，请通过 task_id 轮询结果' });
}

async function handlePoll(event: RequestEvent) {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  const taskId = event.url.searchParams.get('task_id')?.trim();
  if (!taskId) return json({ ok: false, msg: '缺少 task_id' }, 400);
  const task = bgTasks.get(taskId);
  if (!task) return json({ ok: false, msg: '任务不存在' }, 404);
  if (task.status === 'pending') return json({ ok: true, status: 'pending', msg: '生图进行中...' });
  bgTasks.delete(taskId);
  if (task.status === 'done') return json({ ok: true, status: 'done', ...(task.result || {}) });
  return json({ ok: false, status: 'error', ...(task.result || {}) }, task.result?.code ? 400 : 500);
}

async function handleHomeFavorites(event: RequestEvent, pathname: string) {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  if (pathname.startsWith('assets/home-favorites/file/')) {
    const filename = pathname.slice('assets/home-favorites/file/'.length);
    const safe = safeRootPath(path.join('assets/home-favorites', filename));
    if (!safe) return json({ ok: false, msg: '非法 path' }, 400);
    return sendFile(safe.target);
  }
  if (pathname === 'assets/home-favorites/list') {
    const idx = await loadHomeFavorites();
    const items = [];
    for (const it of idx.items) {
      const rel = String(it.path || '');
      const abs = path.join(rootDir, rel);
      if (!rel || !existsSync(abs)) continue;
      const fn = path.basename(rel);
      items.push({ id: it.id, path: rel, url: `/assets/home-favorites/file/${fn}`, thumb_url: `/assets/home-favorites/file/${fn}`, created_at: it.created_at || '' });
    }
    items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return json({ ok: true, items });
  }
  const target = path.join(frontendPath, 'office_bg_small.webp');
  if (pathname === 'assets/home-favorites/save-current') {
    if (!existsSync(target)) return json({ ok: false, msg: 'office_bg_small.webp 不存在' }, 404);
    await ensureHomeFavoritesIndex();
    const id = `home-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
    const filename = `${id}.webp`;
    const dst = path.join(homeFavoritesDir, filename);
    await copyFile(target, dst);
    const idx = await loadHomeFavorites();
    idx.items.unshift({ id, path: path.relative(rootDir, dst).split(path.sep).join('/'), created_at: new Date().toISOString() });
    await saveHomeFavorites(idx);
    return json({ ok: true, id, path: path.relative(rootDir, dst).split(path.sep).join('/'), msg: '已收藏当前地图' });
  }
  const data = await requestJson(event);
  const id = String(data?.id || '').trim();
  if (!id) return json({ ok: false, msg: '缺少 id' }, 400);
  const idx = await loadHomeFavorites();
  const hit = idx.items.find((x) => x.id === id);
  if (!hit) return json({ ok: false, msg: '收藏项不存在' }, 404);
  const src = path.join(rootDir, String(hit.path || ''));
  if (pathname === 'assets/home-favorites/apply') {
    if (!existsSync(src)) return json({ ok: false, msg: '收藏文件不存在' }, 404);
    await copyFile(target, `${target}.bak`);
    await copyFile(src, target);
    const st = await stat(target);
    return json({ ok: true, path: 'office_bg_small.webp', size: st.size, from: hit.path, msg: '已应用收藏地图' });
  }
  if (pathname === 'assets/home-favorites/delete') {
    await rm(src, { force: true });
    idx.items = idx.items.filter((x) => x.id !== id);
    await saveHomeFavorites(idx);
    return json({ ok: true, id, msg: '已删除收藏' });
  }
  return null;
}

async function restoreBackground(event: RequestEvent, mode: 'reference' | 'last') {
  const guard = requireAssetAuth(event);
  if (guard) return guard;
  const target = path.join(frontendPath, 'office_bg_small.webp');
  if (!existsSync(target)) return json({ ok: false, msg: 'office_bg_small.webp 不存在' }, 404);
  let src = '';
  if (mode === 'reference') {
    if (!existsSync(roomReferenceImage)) return json({ ok: false, msg: '参考图不存在' }, 404);
    src = roomReferenceImage;
  } else {
    if (!existsSync(bgHistoryDir)) return json({ ok: false, msg: '暂无历史底图' }, 404);
    const files = (await readdir(bgHistoryDir))
      .filter((x) => x.startsWith('office_bg_small-') && x.endsWith('.webp'))
      .map((x) => path.join(bgHistoryDir, x));
    if (!files.length) return json({ ok: false, msg: '暂无历史底图' }, 404);
    src = files.sort().at(-1) || '';
  }
  await copyFile(target, `${target}.bak`);
  if (path.extname(src).toLowerCase() === '.webp') {
    await copyFile(src, target);
  } else {
    await sharp(src).resize(1280, 720).webp({ quality: 92 }).toFile(`${target}.tmp`);
    await rename(`${target}.tmp`, target);
  }
  const st = await stat(target);
  return json({ ok: true, path: 'office_bg_small.webp', size: st.size, msg: mode === 'reference' ? '已恢复初始底图' : '已回退到最近一次生成底图' });
}

export async function handlePath(event: RequestEvent, rawPath = ''): Promise<Response> {
  const pathname = rawPath.replace(/^\/+|\/+$/g, '');
  const page = await routePages(pathname);
  if (page) return page;

  if (event.request.method === 'GET' && pathname === 'health') {
    return json({ status: 'ok', service: 'star-office-ui', timestamp: new Date().toISOString() });
  }
  if (event.request.method === 'GET' && pathname === 'status') {
    const state = await loadState();
    const officeName = await getOfficeNameFromIdentity();
    if (officeName) state.officeName = officeName;
    return json(state);
  }
  if (event.request.method === 'POST' && pathname === 'set_state') {
    const data = await requestJson(event);
    if (!data) return json({ status: 'error', msg: 'invalid json' }, 400);
    const state = await loadState();
    if (data.state !== undefined && validStates.has(String(data.state) as AgentState)) state.state = String(data.state);
    if (data.detail !== undefined) state.detail = String(data.detail);
    state.updated_at = new Date().toISOString();
    await saveState(state);
    return json({ status: 'ok' });
  }
  if (event.request.method === 'GET' && pathname === 'agents') return handleAgents();
  if (event.request.method === 'POST' && pathname === 'join-agent') return handleJoinAgent(event);
  if (event.request.method === 'POST' && pathname === 'agent-push') return handleAgentPush(event);
  if (event.request.method === 'POST' && pathname === 'leave-agent') return handleLeaveAgent(event);
  if (event.request.method === 'POST' && pathname === 'agent-approve') return handleApproveReject(event, false);
  if (event.request.method === 'POST' && pathname === 'agent-reject') return handleApproveReject(event, true);
  if (event.request.method === 'GET' && pathname === 'yesterday-memo') return json(await getYesterdayMemo());

  if (event.request.method === 'GET' && pathname === 'assets/template.zip') {
    return sendFile(path.join(rootDir, 'assets-replace-template.zip'));
  }
  if (event.request.method === 'GET' && pathname === 'assets/list') return handleAssetsList();
  if (event.request.method === 'POST' && pathname === 'assets/auth') {
    const data = await requestJson(event);
    if (String(data?.password || '').trim() === assetDrawerPass) {
      event.cookies.set('star_asset_editor_authed', '1', { path: '/', httpOnly: true, sameSite: 'lax', secure: false });
      return json({ ok: true, msg: '认证成功' });
    }
    return json({ ok: false, msg: '验证码错误' }, 401);
  }
  if (event.request.method === 'GET' && pathname === 'assets/auth/status') {
    return json({ ok: true, authed: isAssetAuthed(event), drawer_default_pass: assetDrawerPass === '1234' });
  }
  if (pathname === 'assets/positions' && ['GET', 'POST'].includes(event.request.method)) return handlePositionMap(event, assetPositionsFile);
  if (pathname === 'assets/defaults' && ['GET', 'POST'].includes(event.request.method)) return handlePositionMap(event, assetDefaultsFile);
  if (pathname === 'config/gemini' && ['GET', 'POST'].includes(event.request.method)) return handleGeminiConfig(event);
  if (event.request.method === 'POST' && pathname === 'assets/upload') return handleAssetUpload(event);
  if (event.request.method === 'POST' && pathname === 'assets/restore-default') return restoreAsset(event, 'default');
  if (event.request.method === 'POST' && pathname === 'assets/restore-prev') return restoreAsset(event, 'prev');
  if (event.request.method === 'POST' && pathname === 'assets/generate-rpg-background') return handleGenerateBackground(event);
  if (event.request.method === 'GET' && pathname === 'assets/generate-rpg-background/poll') return handlePoll(event);
  if (event.request.method === 'POST' && pathname === 'assets/restore-reference-background') return restoreBackground(event, 'reference');
  if (event.request.method === 'POST' && pathname === 'assets/restore-last-generated-background') return restoreBackground(event, 'last');
  if (pathname.startsWith('assets/home-favorites/')) {
    const result = await handleHomeFavorites(event, pathname);
    if (result) return result;
  }

  return json({ ok: false, msg: 'not found' }, 404);
}

export async function handleStatic(pathname: string) {
  const safe = safeFrontendPath(pathname);
  if (!safe) return json({ ok: false, msg: '非法 path' }, 400);
  return sendFile(safe.target, true);
}
