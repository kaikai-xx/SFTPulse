<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { ConnectionProfile } from '../../main/types'
import ConnectionManager from './components/ConnectionManager.vue'
import FilesPanel from './components/FilesPanel.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import TasksPanel from './components/TasksPanel.vue'
import DbPanel from './components/DbPanel.vue'

const connections = ref<ConnectionProfile[]>([])
const currentId = ref<string>('')
const connected = ref(false)
const connecting = ref(false)
const manageVisible = ref(false)
const pinned = ref(false)

async function togglePin(): Promise<void> {
  pinned.value = await window.api.setPin(!pinned.value)
  ElMessage({ message: pinned.value ? '已置顶：窗口将浮在其他软件之上' : '已取消置顶', type: 'success', duration: 1200 })
}

const currentConn = computed(() => connections.value.find((c) => c.id === currentId.value) || null)

async function loadConnections(): Promise<void> {
  connections.value = await window.api.listConnections()
  if (!currentId.value && connections.value.length) currentId.value = connections.value[0].id
}

async function handleConnect(): Promise<void> {
  if (!currentId.value) {
    ElMessage.warning('请先选择或新建一个连接')
    return
  }
  connecting.value = true
  try {
    await window.api.connect(currentId.value)
    connected.value = true
    ElMessage.success(`已连接到 ${currentConn.value?.host}`)
  } catch (e) {
    connected.value = false
    ElMessage.error('连接失败：' + (e as Error).message)
  } finally {
    connecting.value = false
  }
}

async function handleDisconnect(): Promise<void> {
  if (!currentId.value) return
  await window.api.disconnect(currentId.value)
  connected.value = false
  ElMessage.info('已断开连接')
}

function onSelectConnection(): void {
  connected.value = false
}

onMounted(loadConnections)
</script>

<template>
  <header class="app-header">
    <div class="brand">⚡ SFTPulse</div>

    <el-select
      v-model="currentId"
      placeholder="选择连接"
      style="width: 220px"
      @change="onSelectConnection"
    >
      <el-option
        v-for="c in connections"
        :key="c.id"
        :label="`${c.name} (${c.username}@${c.host})`"
        :value="c.id"
      />
    </el-select>

    <template v-if="!connected">
      <el-button type="primary" :loading="connecting" :disabled="!currentId" @click="handleConnect">
        连接
      </el-button>
    </template>
    <template v-else>
      <el-button type="success" plain disabled>
        <span class="status-dot on"></span>已连接
      </el-button>
      <el-button @click="handleDisconnect">断开</el-button>
    </template>

    <div class="spacer"></div>
    <el-button text class="pin-btn" :class="{ on: pinned }" @click="togglePin" :title="pinned ? '取消置顶' : '固定到最前（不被其他窗口遮挡）'">
      {{ pinned ? '📌' : '📍' }}
    </el-button>
    <el-button text style="color: #fff" @click="manageVisible = true">⚙ 连接管理</el-button>
  </header>

  <div class="app-body">
    <el-tabs type="border-card" class="main-tabs">
      <el-tab-pane label="📁 文件传输">
        <FilesPanel :connection-id="currentId" :connected="connected" :default-remote-dir="currentConn?.remoteDir || '/'" />
      </el-tab-pane>
      <el-tab-pane label="💻 终端">
        <TerminalPanel :connection-id="currentId" :connected="connected" />
      </el-tab-pane>
      <el-tab-pane label="🚀 一键任务">
        <TasksPanel />
      </el-tab-pane>
      <el-tab-pane label="🗄 数据库同步">
        <DbPanel />
      </el-tab-pane>
    </el-tabs>
  </div>

  <ConnectionManager v-model:visible="manageVisible" @saved="loadConnections" />
</template>

<style scoped>
.main-tabs {
  height: 100%;
}
.pin-btn {
  font-size: 18px;
  color: #cbd5e1 !important;
}
.pin-btn.on {
  color: #fbbf24 !important;
}
:deep(.el-tabs__content) {
  padding: 14px;
}
</style>
