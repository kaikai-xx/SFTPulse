import { type ClientChannel } from 'ssh2'
import { requireClient } from './sshService'

/**
 * 交互式终端：基于 ssh2 的 shell(pty) 通道。
 * 主进程只负责通道生命周期与字节转发，渲染层由 xterm.js 负责渲染。
 */
interface TerminalSession {
  connId: string
  stream: ClientChannel
}

const terminals = new Map<string, TerminalSession>()

export async function open(
  connId: string,
  cols: number,
  rows: number,
  onData: (termId: string, buf: Buffer) => void,
  onExit: (termId: string) => void
): Promise<string> {
  const conn = requireClient(connId)
  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', rows, cols }, (err, s) => (err ? reject(err) : resolve(s)))
  })
  const termId = 'term-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  terminals.set(termId, { connId, stream })
  stream.on('data', (buf: Buffer) => onData(termId, buf))
  stream.on('close', () => {
    terminals.delete(termId)
    onExit(termId)
  })
  stream.stderr.on('data', (buf: Buffer) => onData(termId, buf))
  return termId
}

/** data 为渲染层 base64 编码后的字节，避免多字节字符被截断 */
export function write(termId: string, dataBase64: string): void {
  terminals.get(termId)?.stream.write(Buffer.from(dataBase64, 'base64'))
}

export function resize(termId: string, cols: number, rows: number): void {
  const s = terminals.get(termId)?.stream as
    | (ClientChannel & { setWindow?: (rows: number, cols: number, h: number, w: number) => void })
    | undefined
  s?.setWindow?.(rows, cols, 0, 0)
}

export function close(termId: string): void {
  const s = terminals.get(termId)
  if (!s) return
  terminals.delete(termId)
  try {
    s.stream.close()
  } catch {
    /* ignore */
  }
}

/** 断开连接时连带关闭其上的所有终端 */
export function closeByConn(connId: string): void {
  for (const [id, s] of terminals) {
    if (s.connId === connId) close(id)
  }
}
