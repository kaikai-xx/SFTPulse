import mysql from 'mysql2/promise'
import type { Connection } from 'mysql2/promise'
import * as ssh from './ssh/sshService'
import * as vault from './vault'
import { getDatabaseSecret } from './dbStore'
import type { DbConnection, DbSyncOptions, DbSyncEvent } from './types'

/**
 * 数据库双向同步（MySQL/MariaDB）。
 * - 每个库连接可独立配置 host/port/账号；若绑定 sshConnId，则经由该 SSH 连接开本地端口隧道访问
 *   （此时 host 是“从 SSH 服务器视角”可达的地址，如 127.0.0.1 表示库就在该服务器上）。
 * - 同步按表进行，结构（SHOW CREATE TABLE -> DROP/CREATE）与数据（分批 SELECT -> 批量 INSERT）分别可选。
 * - 全过程以 DbSyncEvent 流式回推，单表失败不中断其余表，最后汇总。
 */

function id(name: string): string {
  return '`' + name.replace(/`/g, '') + '`'
}

async function ensureSsh(sshId: string): Promise<void> {
  if (ssh.isConnected(sshId)) return
  const prof = vault.getProfile(sshId)
  if (!prof) throw new Error('隧道绑定的 SSH 连接已被删除，请编辑数据库配置重新选择')
  const secrets = vault.getSecrets(sshId)
  await ssh.connect(sshId, {
    host: prof.host,
    port: prof.port,
    username: prof.username,
    password: secrets.password,
    privateKeyPath: prof.privateKeyPath,
    passphrase: secrets.passphrase
  })
}

interface Opened {
  conn: Connection
  close: () => Promise<void>
}

/** 用一份完整的库配置（含明文密码）建立连接；database 可为空（仅连上服务器枚举库） */
async function openDbConfig(db: DbConnection): Promise<Opened> {
  let host = db.host
  let port = db.port
  let tunnel: ssh.TunnelHandle | null = null
  try {
    if (db.sshConnId) {
      await ensureSsh(db.sshConnId)
      tunnel = await ssh.openTunnel(db.sshConnId, db.host, db.port)
      host = '127.0.0.1'
      port = tunnel.port
    }
    const conn = await mysql.createConnection({
      host,
      port,
      user: db.user,
      password: db.password,
      database: db.database || undefined,
      connectTimeout: 15000,
      multipleStatements: true
    })
    return {
      conn,
      close: async () => {
        try {
          await conn.end()
        } catch {
          /* ignore */
        }
        if (tunnel) tunnel.close()
      }
    }
  } catch (e) {
    if (tunnel) tunnel.close()
    throw e
  }
}

async function openDb(dbId: string): Promise<Opened> {
  const db = getDatabaseSecret(dbId)
  if (!db) throw new Error('数据库连接不存在')
  return openDbConfig(db)
}

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

/**
 * 枚举某个连接可访问的数据库（SHOW DATABASES）。
 * 传入的是表单当前配置；若密码留空且带 id，则回退用已保存的密码（编辑时不必重输）。
 */
export async function listDatabases(input: DbConnection): Promise<string[]> {
  const db: DbConnection = { ...input }
  if (!db.password && db.id) db.password = getDatabaseSecret(db.id)?.password || ''
  const o = await openDbConfig(db)
  try {
    const [rows] = await o.conn.query('SHOW DATABASES')
    return (rows as Record<string, unknown>[])
      .map((r) => String(Object.values(r)[0]))
      .filter((n) => !SYSTEM_SCHEMAS.has(n.toLowerCase()))
  } finally {
    await o.close()
  }
}

/** 测试连接，返回版本/库/用户摘要 */
export async function testConnection(dbId: string): Promise<string> {
  const o = await openDb(dbId)
  try {
    const [rows] = await o.conn.query('SELECT VERSION() AS v, DATABASE() AS d, CURRENT_USER() AS u')
    const r = (rows as { v: string; d: string; u: string }[])[0]
    return `${r.v}｜库 ${r.d}｜用户 ${r.u}`
  } finally {
    await o.close()
  }
}

/** 列出某个库的所有表名 */
export async function listTables(dbId: string): Promise<string[]> {
  const o = await openDb(dbId)
  try {
    const [rows] = await o.conn.query('SHOW TABLES')
    return (rows as Record<string, unknown>[]).map((r) => String(Object.values(r)[0]))
  } finally {
    await o.close()
  }
}

async function getColumns(conn: Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${id(table)}`)
  return (rows as { Field: string }[]).map((r) => r.Field)
}

async function getCreate(conn: Connection, table: string): Promise<string> {
  const [rows] = await conn.query(`SHOW CREATE TABLE ${id(table)}`)
  const r = (rows as Record<string, unknown>[])[0]
  return String(r['Create Table'] ?? r['Create View'] ?? '')
}

const CHUNK = 500

/**
 * 执行同步。返回失败表数（0 = 全部成功）。
 */
export async function syncDatabase(opts: DbSyncOptions, emit: (ev: DbSyncEvent) => void): Promise<number> {
  const log = (t: string): void => emit({ kind: 'log', text: t })

  if (!opts.tables.length) {
    log('⚠ 未选择任何表')
    return 1
  }
  if (opts.sourceId === opts.targetId) {
    log('✖ 源与目标不能是同一个数据库连接')
    return 1
  }
  if (!opts.structure && !opts.data) {
    log('✖ 请至少勾选「结构」或「数据」')
    return 1
  }
  const src = getDatabaseSecret(opts.sourceId)
  const tgt = getDatabaseSecret(opts.targetId)
  if (!src || !tgt) {
    log('✖ 源或目标数据库连接不存在')
    return 1
  }

  log(`▶ ${new Date().toLocaleTimeString()} 开始同步：「${src.name}」 → 「${tgt.name}」，共 ${opts.tables.length} 张表`)

  let s: Opened
  try {
    s = await openDb(opts.sourceId)
  } catch (e) {
    log('✖ 源库连接失败：' + (e as Error).message)
    return 1
  }
  let t: Opened
  try {
    t = await openDb(opts.targetId)
  } catch (e) {
    await s.close()
    log('✖ 目标库连接失败：' + (e as Error).message)
    return 1
  }

  let failed = 0
  try {
    await t.conn.query('SET FOREIGN_KEY_CHECKS=0')
    const count = opts.tables.length
    let index = 0
    for (const table of opts.tables) {
      index++
      try {
        if (opts.structure) {
          emit({ kind: 'table', table, index, count, rowsDone: 0, rowsTotal: 0, phase: '结构' })
          const ddl = await getCreate(s.conn, table)
          if (!ddl) throw new Error('无法获取表结构')
          if (opts.dropExisting) await t.conn.query(`DROP TABLE IF EXISTS ${id(table)}`)
          await t.conn.query(ddl)
          log(`· [${index}/${count}] ${table}：结构已同步`)
        }
        if (opts.data) {
          const cols = await getColumns(s.conn, table)
          if (!cols.length) throw new Error('源表无列信息')
          const [cntRows] = await s.conn.query(`SELECT COUNT(*) AS n FROM ${id(table)}`)
          const total = Number((cntRows as { n: number | string }[])[0].n)
          if (opts.truncateBeforeInsert) await t.conn.query(`TRUNCATE TABLE ${id(table)}`)
          const colList = cols.map(id).join(', ')
          const [rows] = await s.conn.query(`SELECT ${colList} FROM ${id(table)}`)
          const list = rows as Record<string, unknown>[]
          let done = 0
          for (let i = 0; i < list.length; i += CHUNK) {
            const chunk = list.slice(i, i + CHUNK)
            const values = chunk.map((r) => cols.map((c) => r[c]))
            await t.conn.query(`INSERT INTO ${id(table)} (${colList}) VALUES ?`, [values])
            done += chunk.length
            emit({ kind: 'table', table, index, count, rowsDone: done, rowsTotal: total, phase: '数据' })
          }
          log(`· [${index}/${count}] ${table}：数据已同步 ${done}/${total} 行`)
        }
      } catch (e) {
        failed++
        log(`✖ [${index}/${count}] ${table} 同步失败：${(e as Error).message}`)
      }
    }
    await t.conn.query('SET FOREIGN_KEY_CHECKS=1')
  } finally {
    await s.close()
    await t.close()
  }

  if (failed) log(`⚠ 同步结束：共 ${failed} 张表失败，请检查上方输出`)
  else log('✔ 同步全部完成')
  return failed
}
