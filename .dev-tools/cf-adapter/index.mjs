import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'

const SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function emit(payload, exitCode) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  process.exit(exitCode)
}

function ok(data) {
  emit(data === undefined ? { status: 'ok' } : { status: 'ok', data }, 0)
}

function fail(reason) {
  emit({ status: 'failed', reason: String(reason || '未知错误') }, 1)
}

function requireEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`缺少必需环境变量 ${name}`)
  return value
}

function requireSuffix() {
  const suffix = requireEnv('EUCLI_CF_INSTANCE_SUFFIX')
  if (!SUFFIX_RE.test(suffix)) {
    throw new Error(`实例身份后缀 ${JSON.stringify(suffix)} 非法，拒绝启动`)
  }
  return suffix
}

function readJsonSync(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function loadAppMeta(worktree) {
  const fwApp = readJsonSync(path.join(worktree, '.fast-window-dev-protocol', 'fw-app.json'))
  const buildCfg = readJsonSync(path.join(worktree, 'fw-app.build.json'))
  const pkg = readJsonSync(path.join(worktree, 'package.json'))
  const tauriConf = readJsonSync(path.join(worktree, 'src-tauri', 'tauri.conf.json'))
  const appId = String(fwApp.id || '').trim()
  const entryExe = String(fwApp?.package?.windowsExecutable || '').trim()
  if (!appId || !entryExe) {
    throw new Error('fw-app.json 缺少 id 或 package.windowsExecutable')
  }
  return { appId, entryExe, buildCfg, pkg, tauriConf }
}

function cmdQuote(value) {
  const raw = String(value)
  if (!raw) return '""'
  if (!/[\s"^&|<>%]/.test(raw)) return raw
  return `"${raw.replaceAll('%', '%%').replace(/["^]/g, m => `^${m}`)}"`
}

function spawnCmd(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let specCommand = command
    let specArgs = args
    if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
      specCommand = process.env.ComSpec || 'cmd.exe'
      specArgs = ['/d', '/s', '/c', [`${command}.cmd`, ...args].map(cmdQuote).join(' ')]
    }
    process.stderr.write(`[cf-adapter] (${opts.cwd || process.cwd()}) ${command} ${args.join(' ')}\n`)
    const child = spawn(specCommand, specArgs, {
      stdio: ['ignore', process.stderr, process.stderr],
      shell: false,
      ...opts,
    })
    child.on('error', reject)
    child.on('exit', code => {
      if ((code ?? 0) === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）`))
    })
  })
}

function cleanTauriEnv(baseEnv) {
  const env = { ...baseEnv }
  delete env.TAURI_CONFIG
  delete env.FAST_WINDOW_HOST_PROFILE
  delete env.VITE_FAST_WINDOW_HOST_PROFILE
  return env
}


function findSccacheBin(currentPath) {
  const exeName = process.platform === 'win32' ? 'sccache.exe' : 'sccache'
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of String(currentPath || '').split(sep).map(s => s.trim()).filter(Boolean)) {
    const candidate = path.join(dir, exeName)
    if (fs.existsSync(candidate)) return candidate
  }
  return ''
}

function spaceSccachePort(depsStore) {
  const hash = crypto.createHash('sha256').update(path.resolve(depsStore).toLowerCase()).digest()
  const num = hash.readUInt16BE(0)
  return 42300 + (num % 10000)
}

function configureSpaceSccache(env, depsStore) {
  const bin = findSccacheBin(env.PATH || env.Path)
  if (!bin) return
  const cacheDir = path.join(depsStore, 'sccache')
  fs.mkdirSync(cacheDir, { recursive: true })
  env.RUSTC_WRAPPER = bin
  env.SCCACHE_DIR = cacheDir
  env.SCCACHE_SERVER_PORT = String(spaceSccachePort(depsStore))
  env.SCCACHE_IDLE_TIMEOUT = '180'
  env.CARGO_INCREMENTAL = '0'
  try {
    spawnSync(bin, ['--start-server'], { env, stdio: 'ignore' })
  } catch {
    // ignore start errors; sccache client will retry or fail cleanly
  }
}

function toolchainEnv(depsStore, cargoTargetDir) {
  const env = cleanTauriEnv(process.env)
  env.npm_config_cache = path.join(depsStore, 'npm')
  env.GOMODCACHE = path.join(depsStore, 'go', 'pkg', 'mod')
  env.GOCACHE = path.join(depsStore, 'go', 'build-cache')
  env.CARGO_HOME = path.join(depsStore, 'cargo')
  if (cargoTargetDir) {
    env.CARGO_TARGET_DIR = cargoTargetDir
    configureSpaceSccache(env, depsStore)
  }
  return env
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function hostTuple() {
  return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
}

function snapshotLineEndingFiles(worktree) {
  const candidates = [path.join(worktree, 'src-tauri', 'Cargo.toml')]
  const schemasDir = path.join(worktree, 'src-tauri', 'gen', 'schemas')
  if (fs.existsSync(schemasDir)) {
    for (const entry of fs.readdirSync(schemasDir)) {
      if (entry.endsWith('.json')) {
        candidates.push(path.join(schemasDir, entry))
      }
    }
  }
  const snap = new Map()
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      snap.set(file, fs.readFileSync(file))
    }
  }
  return snap
}

function restoreIdenticalLineEndings(snap) {
  for (const [file, origBuf] of snap.entries()) {
    if (!fs.existsSync(file)) continue
    const curBuf = fs.readFileSync(file)
    if (curBuf.equals(origBuf)) continue
    const origNorm = origBuf.toString('utf8').replaceAll('\r\n', '\n')
    const curNorm = curBuf.toString('utf8').replaceAll('\r\n', '\n')
    if (origNorm === curNorm) {
      fs.writeFileSync(file, origBuf)
    }
  }
}

async function cleanupWorktreeIntermediates(worktree) {
  const rels = [
    'dist',
    'dist-app',
    '.tmp',
    path.join('src-tauri', 'binaries'),
    path.join('src-tauri', 'target'),
    path.join('backend-rs', 'target'),
  ]
  for (const rel of rels) {
    await fsp.rm(path.join(worktree, rel), { recursive: true, force: true })
  }
  const backendGoDir = path.join(worktree, 'backend-go')
  if (fs.existsSync(backendGoDir)) {
    for (const entry of fs.readdirSync(backendGoDir)) {
      if (entry.endsWith('.exe')) {
        await fsp.rm(path.join(backendGoDir, entry), { force: true })
      }
    }
  }
}

async function copyEntry(src, dst) {
  const st = await fsp.stat(src)
  if (st.isDirectory()) {
    await fsp.rm(dst, { recursive: true, force: true })
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    await fsp.cp(src, dst, { recursive: true })
    return
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true })
  await fsp.copyFile(src, dst)
}

function resolveMappedSource(worktree, cargoTargetDir, fromRel) {
  const normalized = String(fromRel || '').replaceAll('\\', '/')
  if (normalized.startsWith('src-tauri/target/')) {
    return path.join(cargoTargetDir, normalized.slice('src-tauri/target/'.length))
  }
  return path.join(worktree, normalized)
}

async function cmdDeps() {
  const worktree = requireEnv('EUCLI_CF_WORKTREE')
  const depsDir = requireEnv('EUCLI_CF_DEPS_DIR')
  const depsStore = requireEnv('EUCLI_CF_DEPS_STORE')
  for (const dir of [
    depsDir,
    path.join(depsStore, 'npm'),
    path.join(depsStore, 'go', 'pkg', 'mod'),
    path.join(depsStore, 'go', 'build-cache'),
    path.join(depsStore, 'cargo'),
  ]) {
    await fsp.mkdir(dir, { recursive: true })
  }

  const env = toolchainEnv(depsStore)
  const lockPath = path.join(worktree, 'package-lock.json')
  const stampPath = path.join(depsDir, 'npm-lock.sha256')
  const lockHash = sha256File(lockPath)
  const hasNodeModules = fs.existsSync(path.join(worktree, 'node_modules'))
  const prevHash = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, 'utf8').trim() : ''

  if (!hasNodeModules || prevHash !== lockHash) {
    await spawnCmd('npm', ['ci', '--no-audit', '--no-fund'], { cwd: worktree, env })
    await fsp.writeFile(stampPath, `${lockHash}\n`, 'utf8')
  } else {
    process.stderr.write('[cf-adapter] npm 依赖与锁文件一致，跳过重复安装\n')
  }

  const backendGoDir = path.join(worktree, 'backend-go')
  if (fs.existsSync(path.join(backendGoDir, 'go.mod'))) {
    await spawnCmd('go', ['mod', 'download'], {
      cwd: backendGoDir,
      env: { ...env, GOWORK: 'off' },
    })
  }
}

async function cmdBuild() {
  const worktree = requireEnv('EUCLI_CF_WORKTREE')
  const buildDir = requireEnv('EUCLI_CF_BUILD_DIR')
  const depsStore = requireEnv('EUCLI_CF_DEPS_STORE')
  const { entryExe, buildCfg } = loadAppMeta(worktree)
  const releaseProfile = buildCfg?.profiles?.release
  if (!releaseProfile) throw new Error('fw-app.build.json 缺少 profiles.release')

  const cargoTargetDir = path.join(buildDir, 'cargo-target')
  const packageDir = path.join(buildDir, 'package')
  await fsp.mkdir(buildDir, { recursive: true })

  const env = toolchainEnv(depsStore, cargoTargetDir)
  const lineSnap = snapshotLineEndingFiles(worktree)
  try {
    const buildCmd = releaseProfile.build?.command || 'npm'
    const buildArgs = Array.isArray(releaseProfile.build?.args)
      ? releaseProfile.build.args
      : ['run', 'tauri', '--', 'build', '--no-bundle']
    await spawnCmd(buildCmd, buildArgs, { cwd: worktree, env })

    await fsp.rm(packageDir, { recursive: true, force: true })
    await fsp.mkdir(packageDir, { recursive: true })
    for (const fileMap of releaseProfile.files || []) {
      const src = resolveMappedSource(worktree, cargoTargetDir, fileMap.from)
      const dst = path.join(packageDir, fileMap.to)
      await copyEntry(src, dst)
    }
    const manifestSrc = path.join(worktree, '.fast-window-dev-protocol', 'fw-app.json')
    await fsp.copyFile(manifestSrc, path.join(packageDir, 'fw-app.json'))

    return {
      packageDir,
      executable: path.join(packageDir, entryExe),
    }
  } finally {
    await cleanupWorktreeIntermediates(worktree)
    restoreIdenticalLineEndings(lineSnap)
  }
}

function pidFile(dataRoot) {
  return path.join(dataRoot, 'app.pid')
}

function stdoutLogFile(dataRoot) {
  return path.join(dataRoot, 'stdout.log')
}

function stderrLogFile(dataRoot) {
  return path.join(dataRoot, 'stderr.log')
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readControlFrame(dataRoot) {
  const logPath = stdoutLogFile(dataRoot)
  if (!fs.existsSync(logPath)) return null
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed?.type === 'fw-app-control-ready' && parsed?.control?.url && parsed?.control?.token) {
        return parsed.control
      }
    } catch {
      // ignore non-JSON log lines
    }
  }
  return null
}

function postControl(control, action, expectedAppId) {
  return new Promise((resolve, reject) => {
    const url = new URL('/control', control.url)
    const body = JSON.stringify({ action })
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-FW-Control-Token': control.token,
          Connection: 'close',
        },
        timeout: 2000,
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`POST /control (${action}) 返回 ${res.statusCode}: ${text.trim()}`))
            return
          }
          try {
            const json = JSON.parse(text)
            if (json?.ok && json?.appId === expectedAppId) resolve(json)
            else reject(new Error(`控制响应异常: ${text.trim()}`))
          } catch (err) {
            reject(new Error(`控制响应非 JSON: ${err.message}`))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('控制请求超时'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function cmdStart() {
  const worktree = requireEnv('EUCLI_CF_WORKTREE')
  const suffix = requireSuffix()
  const buildDir = requireEnv('EUCLI_CF_BUILD_DIR')
  const dataRoot = requireEnv('EUCLI_CF_DATA_ROOT')
  const { appId, entryExe } = loadAppMeta(worktree)
  const exePath = path.join(buildDir, 'package', entryExe)
  if (!fs.existsSync(exePath)) {
    throw new Error(`正式构建产物不存在: ${exePath}`)
  }

  await fsp.mkdir(dataRoot, { recursive: true })
  const outPath = stdoutLogFile(dataRoot)
  const errPath = stderrLogFile(dataRoot)
  await fsp.writeFile(outPath, '', 'utf8')
  await fsp.writeFile(errPath, '', 'utf8')

  const outFd = fs.openSync(outPath, 'a')
  const errFd = fs.openSync(errPath, 'a')
  try {
    const child = spawn(exePath, ['--fw-launched', '--fw-action', 'hide'], {
      cwd: path.dirname(exePath),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: {
        ...process.env,
        FW_APP_INSTANCE_SUFFIX: suffix,
        FW_APP_DATA_DIR_OVERRIDE: dataRoot,
        WEBVIEW2_USER_DATA_FOLDER: path.join(dataRoot, 'webview2'),
      },
    })
    child.unref()
    await fsp.writeFile(pidFile(dataRoot), `${child.pid}\n`, 'utf8')
    process.stderr.write(`[cf-adapter] started ${appId} (${suffix}) pid=${child.pid}\n`)
    return {
      pid: child.pid,
      suffix,
      dataRoot,
      stdoutLog: outPath,
      stderrLog: errPath,
    }
  } finally {
    fs.closeSync(outFd)
    fs.closeSync(errFd)
  }
}

async function cmdHealth() {
  const worktree = requireEnv('EUCLI_CF_WORKTREE')
  const dataRoot = requireEnv('EUCLI_CF_DATA_ROOT')
  const { appId } = loadAppMeta(worktree)
  const pFile = pidFile(dataRoot)
  if (!fs.existsSync(pFile)) {
    throw new Error('缺少实例 PID 文件')
  }
  const pid = Number.parseInt(fs.readFileSync(pFile, 'utf8').trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
    throw new Error(`实例进程（pid=${pid}）未在运行`)
  }
  const control = readControlFrame(dataRoot)
  if (!control) {
    throw new Error('尚未收到 fw-app-control-ready 就绪帧')
  }
  await postControl(control, 'hide', appId)
}

async function cmdStop() {
  const worktree = requireEnv('EUCLI_CF_WORKTREE')
  const dataRoot = requireEnv('EUCLI_CF_DATA_ROOT')
  const { appId } = loadAppMeta(worktree)
  const pFile = pidFile(dataRoot)
  if (!fs.existsSync(pFile)) return
  const pid = Number.parseInt(fs.readFileSync(pFile, 'utf8').trim(), 10)
  const control = readControlFrame(dataRoot)
  if (control) {
    try {
      await postControl(control, 'close', appId)
    } catch {
      // fall through to process termination
    }
  }

  for (let i = 0; i < 30; i += 1) {
    if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
      await fsp.rm(pFile, { force: true })
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ignore
    }
  }

  for (let i = 0; i < 20; i += 1) {
    if (!isPidAlive(pid)) {
      await fsp.rm(pFile, { force: true })
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`实例 pid=${pid} 在超时内未能停止`)
}

async function cmdTest() {
  const worktree = requireEnv('EUCLI_CF_WORKTREE')
  const buildDir = requireEnv('EUCLI_CF_BUILD_DIR')
  const dataRoot = requireEnv('EUCLI_CF_DATA_ROOT')
  const depsStore = requireEnv('EUCLI_CF_DEPS_STORE')
  const { pkg, tauriConf } = loadAppMeta(worktree)
  const scripts = pkg.scripts || {}
  const cargoTargetDir = path.join(buildDir, 'cargo-target')

  // 1. 验证运行中的隔离正式实例与控制通道
  await cmdHealth()
  const control = readControlFrame(dataRoot)
  process.stderr.write(`[cf-adapter] smoke: control ready at ${control.url}\n`)

  const env = toolchainEnv(depsStore, cargoTargetDir)

  // 2. 版本一致性、类型检查与前端/构建脚本测试
  if (scripts['apps:version:check']) {
    await spawnCmd('npm', ['run', 'apps:version:check'], { cwd: worktree, env })
  }
  if (scripts['typecheck']) {
    await spawnCmd('npm', ['run', 'typecheck'], { cwd: worktree, env })
  }
  if (scripts['test']) {
    await spawnCmd('npm', ['test'], { cwd: worktree, env })
  }

  // 3. 后端单元测试（Go 或 Rust）
  const backendGoDir = path.join(worktree, 'backend-go')
  if (fs.existsSync(path.join(backendGoDir, 'go.mod'))) {
    await spawnCmd('go', ['test', './...'], {
      cwd: backendGoDir,
      env: { ...env, GOWORK: 'off' },
    })
  }
  const backendRsManifest = path.join(worktree, 'backend-rs', 'Cargo.toml')
  if (fs.existsSync(backendRsManifest)) {
    await spawnCmd('cargo', ['test', '--release', '--manifest-path', backendRsManifest], { cwd: worktree, env })
  }

  // 4. Rust 壳单元测试（为 tauri::generate_context! 临时提供 dist 与 externalBin，结束后立即清理）
  const tuple = hostTuple()
  const externalBins = Array.isArray(tauriConf?.bundle?.externalBin) ? tauriConf.bundle.externalBin : []
  const lineSnap = snapshotLineEndingFiles(worktree)

  try {
    await fsp.mkdir(path.join(worktree, 'dist'), { recursive: true })
    for (const binRel of externalBins) {
      const baseName = path.basename(binRel)
      const ext = process.platform === 'win32' ? '.exe' : ''
      const dst = path.join(worktree, 'src-tauri', `${binRel}-${tuple}${ext}`)
      await fsp.mkdir(path.dirname(dst), { recursive: true })
      const builtCandidate = path.join(buildDir, 'package', `${baseName}${ext}`)
      if (fs.existsSync(builtCandidate)) {
        await fsp.copyFile(builtCandidate, dst)
      } else {
        await fsp.writeFile(dst, '')
      }
    }
    await spawnCmd('cargo', ['test', '--release', '--manifest-path', path.join('src-tauri', 'Cargo.toml')], {
      cwd: worktree,
      env,
    })
  } finally {
    await cleanupWorktreeIntermediates(worktree)
    restoreIdenticalLineEndings(lineSnap)
  }
}

async function main() {
  const sub = process.argv[2]
  switch (sub) {
    case 'deps':
      await cmdDeps()
      ok()
      break
    case 'build':
      ok(await cmdBuild())
      break
    case 'start':
      ok(await cmdStart())
      break
    case 'health':
      await cmdHealth()
      ok()
      break
    case 'stop':
      await cmdStop()
      ok()
      break
    case 'seed':
      emit({ status: 'not-applicable' }, 0)
      break
    case 'test':
      await cmdTest()
      ok()
      break
    default:
      fail(`未知适配器子命令: ${sub || '(空)'}`)
  }
}

main().catch(err => fail(err?.message || err))
