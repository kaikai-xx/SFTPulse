<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RemoteEntry, UploadProgress, QueueEntry } from '../../../main/types'

const props = defineProps<{
  connectionId: string
  connected: boolean
  defaultRemoteDir: string
}>()

const localFiles = ref<string[]>([])
const remoteDir = ref<string>(props.defaultRemoteDir || '/')
const remoteEntries = ref<RemoteEntry[]>([])
const listing = ref(false)
const uploading = ref(false)
const dropActive = ref(false)

/** 传输队列：批次清单 + 每个文件的状态 */
interface QueueItem extends QueueEntry {
  status: 'pending' | 'doing' | 'done'
  pct: number
}
const queue = ref<QueueItem[]>([])

// 上传进度：整体 + 当前文件；下载进度单独一份
const progress = ref<UploadProgress | null>(null)
const dlProgress = ref<UploadProgress | null>(null)
const overallPercent = computed(() => {
  const p = progress.value
  if (!p || !p.count) return 0
  const doneUnits = p.index - 1 + (p.total ? p.transferred / p.total : 0)
  return Math.min(100, Math.round((doneUnits / p.count) * 100))
})

let offProgress: (() => void) | null = null
let offQueue: (() => void) | null = null
onMounted(() => {
  offProgress = window.api.onProgress((p) => {
    if (p.kind === 'download') {
      dlProgress.value = { ...p }
      return
    }
    progress.value = { ...p }
    const item = queue.value[p.index - 1]
    if (item) {
      item.status = p.done ? 'done' : 'doing'
      item.pct = p.total ? Math.round((p.transferred / p.total) * 100) : 100
    }
  })
  offQueue = window.api.onQueue((entries) => {
    queue.value = entries.map((e) => ({ ...e, status: 'pending' as const, pct: 0 }))
  })
})
onUnmounted(() => {
  offProgress?.()
  offQueue?.()
})

watch(
  () => props.defaultRemoteDir,
  (v) => {
    if (v) remoteDir.value = v
  }
)

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** 远程路径的父目录 */
function parentDir(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function posixJoin(dir: string, name: string): string {
  if (!dir || dir === '/') return '/' + name
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

async function addFiles(): Promise<void> {
  const picked = await window.api.pickFiles()
  if (picked.length) localFiles.value = Array.from(new Set([...localFiles.value, ...picked]))
}

async function addFolder(): Promise<void> {
  const picked = await window.api.pickDir()
  if (picked.length) localFiles.value = Array.from(new Set([...localFiles.value, ...picked]))
}

function removeLocal(idx: number): void {
  localFiles.value.splice(idx, 1)
}

/** 拖拽：把资源管理器里的文件/文件夹拖进面板（Electron 官方 webUtils 用法） */
function collectDrop(e: DragEvent): string[] {
  const paths: string[] = []
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    try {
      paths.push(window.api.getPathForFile(f))
    } catch {
      /* 非本地文件（如网页拖入）忽略 */
    }
  }
  return paths
}

function onDrop(e: DragEvent): void {
  dropActive.value = false
  if (!props.connected) {
    ElMessage.warning('请先在顶部连接服务器')
    return
  }
  const paths = collectDrop(e)
  if (!paths.length) return
  localFiles.value = Array.from(new Set([...localFiles.value, ...paths]))
  doUpload()
}

async function browseRemote(): Promise<void> {
  if (!props.connected) {
    ElMessage.warning('请先在顶部连接服务器')
    return
  }
  listing.value = true
  try {
    remoteEntries.value = await window.api.listRemote(props.connectionId, remoteDir.value)
  } catch (e) {
    ElMessage.error('读取目录失败：' + (e as Error).message)
    remoteEntries.value = []
  } finally {
    listing.value = false
  }
}

function enterDir(entry: RemoteEntry): void {
  if (!entry.directory) return
  remoteDir.value = entry.path
  browseRemote()
}

function goUp(): void {
  remoteDir.value = parentDir(remoteDir.value)
  browseRemote()
}

async function doUpload(): Promise<void> {
  if (!props.connected) {
    ElMessage.warning('请先在顶部连接服务器')
    return
  }
  if (!localFiles.value.length) {
    ElMessage.warning('请先选择要上传的文件或文件夹')
    return
  }
  if (uploading.value) return
  uploading.value = true
  progress.value = null
  queue.value = []
  try {
    await window.api.upload(props.connectionId, localFiles.value, remoteDir.value)
    ElMessage.success('上传完成')
    browseRemote()
  } catch (e) {
    ElMessage.error('上传失败：' + (e as Error).message)
  } finally {
    uploading.value = false
  }
}

async function doDownload(entry: RemoteEntry): Promise<void> {
  if (entry.directory) {
    ElMessage.warning('目录暂不支持整体下载，请进入后选择文件')
    return
  }
  try {
    dlProgress.value = { file: entry.name, transferred: 0, total: entry.size, index: 1, count: 1, done: false, kind: 'download' }
    const saved = await window.api.download(props.connectionId, entry.path)
    if (saved) ElMessage.success('已下载到：' + saved)
  } catch (e) {
    ElMessage.error('下载失败：' + (e as Error).message)
  } finally {
    dlProgress.value = null
  }
}

async function doDelete(entry: RemoteEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除「${entry.name}」？${entry.directory ? '目录将被递归删除！' : ''}`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }
  try {
    await window.api.deleteRemote(props.connectionId, entry.path)
    ElMessage.success('已删除')
    browseRemote()
  } catch (e) {
    ElMessage.error('删除失败：' + (e as Error).message)
  }
}

async function doRename(entry: RemoteEntry): Promise<void> {
  let newName = ''
  try {
    const r = await ElMessageBox.prompt('输入新名称', '重命名', {
      inputValue: entry.name,
      inputValidator: (v: string) => (!v || /[\\/]/.test(v) ? '名称不能为空且不能包含 / \\' : true)
    })
    newName = r.value.trim()
  } catch {
    return
  }
  if (!newName || newName === entry.name) return
  try {
    await window.api.renameRemote(props.connectionId, entry.path, posixJoin(parentDir(entry.path), newName))
    ElMessage.success('已重命名')
    browseRemote()
  } catch (e) {
    ElMessage.error('重命名失败：' + (e as Error).message)
  }
}

async function doMkdir(): Promise<void> {
  let name = ''
  try {
    const r = await ElMessageBox.prompt(`将在 ${remoteDir.value} 下创建`, '新建目录', {
      inputValidator: (v: string) => (!v || /[\\/]/.test(v) ? '目录名不能为空且不能包含 / \\' : true)
    })
    name = r.value.trim()
  } catch {
    return
  }
  try {
    await window.api.mkdirRemote(props.connectionId, posixJoin(remoteDir.value, name))
    ElMessage.success('目录已创建')
    browseRemote()
  } catch (e) {
    ElMessage.error('创建目录失败：' + (e as Error).message)
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
</script>

<template>
  <div class="files-panel">
    <!-- 左：本地待上传 -->
    <div class="pane">
      <div class="pane-title">本地待上传</div>
      <div class="row-btns">
        <el-button size="small" @click="addFiles">➕ 选文件</el-button>
        <el-button size="small" @click="addFolder">📂 选文件夹</el-button>
        <el-button size="small" text type="danger" :disabled="!localFiles.length" @click="localFiles = []">
          清空
        </el-button>
      </div>
      <el-scrollbar class="list-box">
        <div v-if="!localFiles.length" class="empty">尚未选择文件（也可直接把文件拖到右侧远程面板上传）</div>
        <div v-for="(f, i) in localFiles" :key="f" class="item">
          <span class="item-name" :title="f">{{ baseName(f) }}</span>
          <el-button link type="danger" size="small" @click="removeLocal(i)">移除</el-button>
        </div>
      </el-scrollbar>
    </div>

    <!-- 右：远程目录（可拖入上传） -->
    <div
      class="pane"
      :class="{ drop: dropActive }"
      @dragover.prevent="dropActive = connected"
      @dragleave="dropActive = false"
      @drop.prevent="onDrop"
    >
      <div class="pane-title">远程目标目录</div>
      <div class="row-btns">
        <el-input v-model="remoteDir" size="small" style="flex: 1" @keyup.enter="browseRemote" />
        <el-button size="small" :disabled="!connected" @click="browseRemote">浏览</el-button>
      </div>
      <div class="row-btns">
        <el-button size="small" text :disabled="!connected" @click="goUp">⬆ 上一级</el-button>
        <el-button size="small" text :disabled="!connected" @click="doMkdir">➕ 新建目录</el-button>
        <el-tag v-if="!connected" type="info" size="small">未连接</el-tag>
        <el-tag v-else type="success" size="small">可拖入文件上传</el-tag>
      </div>
      <el-scrollbar class="list-box" v-loading="listing">
        <div v-if="!connected" class="empty">连接后可浏览远程目录</div>
        <div v-else-if="!remoteEntries.length" class="empty">（空目录）</div>
        <div
          v-for="e in remoteEntries"
          :key="e.path"
          class="item"
          :class="{ clickable: e.directory }"
          @dblclick="enterDir(e)"
        >
          <span class="item-name" :title="e.path">{{ e.directory ? '📁' : '📄' }} {{ e.name }}</span>
          <span class="item-size">{{ e.directory ? '' : fmtSize(e.size) }}</span>
          <span class="item-ops">
            <el-button link type="primary" size="small" :disabled="e.directory" @click.stop="doDownload(e)">
              下载
            </el-button>
            <el-button link type="primary" size="small" @click.stop="doRename(e)">重命名</el-button>
            <el-button link type="danger" size="small" @click.stop="doDelete(e)">删除</el-button>
          </span>
        </div>
      </el-scrollbar>
    </div>

    <!-- 底部：上传 + 队列 + 进度 -->
    <div class="upload-bar">
      <el-button type="primary" :loading="uploading" :disabled="!connected" @click="doUpload">
        ⬆ 上传到当前远程目录
      </el-button>
      <div class="bar-right">
        <div v-if="dlProgress" class="progress-wrap">
          <el-progress
            :percentage="dlProgress.total ? Math.round((dlProgress.transferred / dlProgress.total) * 100) : 0"
            :stroke-width="14"
            status="success"
            striped
            striped-flow
          />
          <div class="progress-text mono">
            ⬇ {{ dlProgress.file }} · {{ fmtSize(dlProgress.transferred) }} / {{ fmtSize(dlProgress.total) }}
          </div>
        </div>
        <template v-else-if="progress">
          <div class="progress-wrap">
            <el-progress :percentage="overallPercent" :stroke-width="14" striped striped-flow />
            <div class="progress-text mono">
              [{{ progress.index }}/{{ progress.count }}] {{ progress.file }} ·
              {{ fmtSize(progress.transferred) }} / {{ fmtSize(progress.total) }}
            </div>
          </div>
          <el-scrollbar v-if="queue.length" class="queue-box">
            <div v-for="(q, i) in queue" :key="i" class="queue-item">
              <span class="q-status">{{ q.status === 'done' ? '✔' : q.status === 'doing' ? '⏳' : '·' }}</span>
              <span class="q-name" :title="q.name">{{ q.name }}</span>
              <span class="q-size">{{ fmtSize(q.size) }}</span>
              <span class="q-pct mono">{{ q.status === 'pending' ? '' : q.pct + '%' }}</span>
            </div>
          </el-scrollbar>
        </template>
        <div v-else class="hint">选择文件后点击上传，或将文件拖入右侧远程目录</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.files-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr auto;
  gap: 14px;
  min-height: 460px;
}
.pane {
  display: flex;
  flex-direction: column;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}
.pane.drop {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7) inset;
}
.pane-title {
  font-weight: 600;
  margin-bottom: 10px;
}
.row-btns {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.list-box {
  flex: 1;
  height: 300px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 6px;
}
.item {
  display: flex;
  align-items: center;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13px;
}
.item:hover {
  background: #f3f4f6;
}
.item.clickable {
  cursor: pointer;
}
.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-size {
  color: #9ca3af;
  font-size: 12px;
  margin-left: 8px;
}
.item-ops {
  margin-left: 10px;
  visibility: hidden;
}
.item:hover .item-ops {
  visibility: visible;
}
.empty {
  color: #9ca3af;
  text-align: center;
  padding: 24px;
  font-size: 13px;
}
.upload-bar {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding: 12px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
}
.bar-right {
  flex: 1;
  min-width: 0;
}
.progress-wrap {
  width: 100%;
}
.progress-text {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}
.queue-box {
  max-height: 130px;
  margin-top: 8px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 4px;
}
.queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #4b5563;
  padding: 2px 4px;
}
.q-status {
  width: 16px;
}
.q-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-size {
  color: #9ca3af;
}
.q-pct {
  width: 42px;
  text-align: right;
}
.hint {
  font-size: 12px;
  color: #9ca3af;
  align-self: center;
}
</style>
