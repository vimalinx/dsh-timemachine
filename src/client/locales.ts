/** Configuration-generation panel dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'timemachine'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.aria': '配置代',
  'panel.title': '配置代',
  'panel.loading': '读取中…',
  'panel.absent': '此实例未记录配置历史',
  'panel.empty': '尚无记录，启动一次后生成',
  'panel.error': '读取配置代失败：{message}',
  'panel.unreadable': '有 {count} 条记录无法读取',
  'status.activated': '已激活',
  'status.failed': '启动失败',
  'status.never': '未启动',
  'badge.lastGood': '最近可用',
  'badge.booted': '当前启动',
  'detail.title': '配置代详情',
  'detail.loading': '读取详情…',
  'detail.error': '读取详情失败：{message}',
  'detail.bundles': 'Bundle 版本',
  'detail.outcomes': '启动记录',
  'detail.noOutcomes': '尚无启动记录',
  'detail.render': '组合结果（只读）',
  'outcome.overlays': '叠加层：{overlays}',
  'version.none': '（无版本）',
  'action.refresh': '刷新',
  'action.restore': '恢复到此配置',
  'action.confirm': '确认恢复',
  'action.cancel': '取消',
  'action.dismiss': '知道了',
  'confirm.title': '恢复配置代 {id}',
  'confirm.files': '将写回以下文件：',
  'confirm.note': '恢复在下次启动时生效。',
  'restore.working': '正在恢复…',
  'restore.done': '已恢复，将在下次启动生效',
  'restore.refused': '恢复被拒绝：{reason}',
  'restore.failed': '恢复失败：{message}',
  'restore.drift': '与记录时相比，以下 bundle 已变化：',
  'restore.driftLine': '{name}：{recorded} → {current}',
  'restore.driftAdded': '（新增）',
  'restore.driftRemoved': '（已移除）',
} satisfies Record<string, string>

/** Translation keys owned by the configuration-generation namespace. */
export type TimeMachineKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Configuration-generation panel copy. */
    timemachine: TimeMachineKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger.aria': 'Config generations',
  'panel.title': 'Config generations',
  'panel.loading': 'Reading…',
  'panel.absent': 'This instance has no recorded configuration history',
  'panel.empty': 'Nothing recorded yet; boot once to produce a record',
  'panel.error': 'Reading the config generations failed: {message}',
  'panel.unreadable': '{count} record(s) could not be read',
  'status.activated': 'Activated',
  'status.failed': 'Boot failed',
  'status.never': 'Never booted',
  'badge.lastGood': 'Last good',
  'badge.booted': 'Booted now',
  'detail.title': 'Generation detail',
  'detail.loading': 'Reading the detail…',
  'detail.error': 'Reading the detail failed: {message}',
  'detail.bundles': 'Bundle versions',
  'detail.outcomes': 'Boot attempts',
  'detail.noOutcomes': 'No boot attempts yet',
  'detail.render': 'Composed configuration (read-only)',
  'outcome.overlays': 'Overlays: {overlays}',
  'version.none': '(no version)',
  'action.refresh': 'Refresh',
  'action.restore': 'Restore this configuration',
  'action.confirm': 'Confirm restore',
  'action.cancel': 'Cancel',
  'action.dismiss': 'Got it',
  'confirm.title': 'Restore generation {id}',
  'confirm.files': 'These files will be written back:',
  'confirm.note': 'The restore takes effect at the next boot.',
  'restore.working': 'Restoring…',
  'restore.done': 'Restored; takes effect at the next boot',
  'restore.refused': 'Restore refused: {reason}',
  'restore.failed': 'Restore failed: {message}',
  'restore.drift': 'These bundles changed since the record:',
  'restore.driftLine': '{name}: {recorded} → {current}',
  'restore.driftAdded': '(added)',
  'restore.driftRemoved': '(removed)',
} satisfies Record<TimeMachineKey, string>
