<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  connectionId: string
  connected: boolean
}>()

const hostEl = ref<HTMLDivElement | null>(null)
const opening = ref(false)
const ready = ref(false)

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let termId = ''
let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null

/** utf-8 字符串 → base64（跨进程传输避免多字节截断） */
function toB64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

function ensureTerm(): Terminal {
  if (term) return term
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: { background: '#101418', foreground: '#d5dae2' }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(hostEl.value as HTMLElement)
  fitAddon.fit()
  term.onData((d) => {
    if (termId) window.api.termWrite(termId, toB64(d))
  })
  term.onResize(({ cols, rows }) => {
    if (termId) window.api.termResize(termId, cols, rows)
  })
  return term
}

async function openShell(): Promise<void> {
  if (!props.connected || termId || opening.value) return
  opening.value = true
  try {
    await nextTick()
    const t = ensureTerm()
    fitAddon?.fit()
    termId = await window.api.termOpen(props.connectionId, t.cols, t.rows)
    ready.value = true
    t.focus()
  } catch (e) {
    ElMessage.error('打开终端失败：' + (e as Error).message)
  } finally {
    opening.value = false
  }
}

function reconnect(): void {
  const old = term
  termId = ''
  ready.value = false
  old?.dispose()
  term = null
  fitAddon = null
  openShell()
}

function onWindowResize(): void {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    fitAddon?.fit()
  }, 120)
}

watch(
  () => props.connected,
  (v) => {
    if (v) openShell()
    else {
      // 连接断开时主进程会关掉 pty，这里只重置本地状态
      termId = ''
      ready.value = false
    }
  }
)

onMounted(() => {
  offData = window.api.onTermData((p) => {
    if (p.termId && p.termId === termId) term?.write(fromB64(p.data))
  })
  offExit = window.api.onTermExit((p) => {
    if (p.termId && p.termId === termId) {
      termId = ''
      ready.value = false
      term?.writeln('\r\x1b[33m[远程会话已结束]\x1b[0m')
    }
  })
  window.addEventListener('resize', onWindowResize)
  if (props.connected) openShell()
})
onBeforeUnmount(() => {
  offData?.()
  offExit?.()
  window.removeEventListener('resize', onWindowResize)
  if (termId) window.api.termClose(termId)
})
</script>

<template>
  <div class="term-panel">
    <div class="term-bar">
      <el-tag v-if="ready" type="success" size="small">● 终端会话进行中</el-tag>
      <el-tag v-else-if="connected" type="warning" size="small">会话未建立</el-tag>
      <el-tag v-else type="info" size="small">未连接服务器</el-tag>
      <div class="spacer"></div>
      <el-button size="small" :disabled="!connected" :loading="opening" @click="openShell">
        建立会话
      </el-button>
      <el-button size="small" :disabled="!ready && !connected" @click="reconnect">重新连接</el-button>
      <el-button size="small" @click="term?.clear()">清屏</el-button>
    </div>
    <div class="term-host-wrap">
      <div ref="hostEl" class="term-host"></div>
      <div v-if="!connected" class="term-overlay">请先在顶部连接服务器，连接后此处将自动打开交互式终端</div>
    </div>
  </div>
</template>

<style scoped>
.term-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 210px);
  min-height: 380px;
}
.term-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.spacer {
  flex: 1;
}
.term-host-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #101418;
  border-radius: 8px;
  padding: 8px;
}
.term-host {
  width: 100%;
  height: 100%;
}
.term-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  font-size: 13px;
  background: rgba(16, 20, 24, 0.88);
  border-radius: 8px;
}
</style>
