import { zoomEn, zoomZh } from '../zoom/locales.ts'

/** Copy owned by the PDF renderer. */
export const zh = {
  ...zoomZh,
  title: 'PDF',
  pageImage: 'PDF 第 {page} 页',
  loading: '文档渲染中...',
  rendering: '正在绘制页面…',
  failed: '无法显示 PDF：{message}',
  password: '此 PDF 需要密码，暂不支持预览',
  workerFailed: 'PDF 渲染进程无法继续，请重试',
  unsupported: 'PDF 预览需要完整文件内容',
  retry: '重试',
  highlightColors: '选择高亮颜色',
  yellow: '黄色高亮', green: '绿色高亮', blue: '蓝色高亮', pink: '粉色高亮', orange: '橙色高亮',
  highlightDismiss: '取消',
  highlightDeleteHint: '点击高亮可删除，双击文字可选词',
  highlightActions: '高亮操作', highlightDelete: '删除高亮',
  translate: '翻译', translationTitle: '划词翻译', translationLoading: '正在结合上下文翻译…',
  translationHistory: '翻译历史', translationHistoryOpen: '查看翻译历史：{text}', translationHistoryClose: '关闭',
  translationHistoryVersions: '此处的翻译记录', translationHistoryVersion: '记录 {index}',
  translationHistoryFailed: '翻译历史未能加载，已有标记和内容已保留，请重试',
  translationMeanings: '基本词义', translationKeyMeaning: '关键含义', translationContextual: '此处含义', translationSentence: '原句与译文',
  translationContext: '查看上下文 · 第 {page} 页', translationContextLimited: '此处可用的前后文不足各两句，或选区位于独立标题、图注等内容中',
  translationSpeak: '朗读', translationStopSpeaking: '停止朗读', translationSpeechHint: '朗读使用设备的英语语音',
  translationDictionary: '音标来源', translationPhoneticsUnavailable: '暂无可靠音标',
  translationPin: '固定', translationUnpin: '取消固定', translationSave: '加入学习笔记', translationSaving: '保存中…', translationSaved: '已加入笔记',
  translationAsk: '继续问 Agent', translationInserted: '原文和解释已加入 Agent 输入框，可补充问题后发送',
  translationFailed: '翻译未完成，选中内容已保留，请重试', translationTimeout: '翻译超时，选中内容已保留，请重试',
  translationUnavailable: '翻译模型尚未就绪，请先在论文会话中选择可用模型后重试',
  translationSelectionFailed: '未能定位这段原文，请重新选择文字后翻译', translationNoText: '无法提取原文文字，请先使用带文字层的 PDF',
  translationLimit: '翻译超出处理或保存限制，请缩小选区，或调整后端的翻译限制后重试', translationSourceChanged: 'PDF 原文已变化，请刷新论文后重新选择文字',
  translationSaveFailed: '未能加入学习笔记，已有笔记已保留，请重试', translationAskFailed: '未能加入 Agent 输入框，请等待会话加载后重试',
  translationSpeakFailed: '英语朗读不可用，请检查设备语音设置后重试',
  highlightRemove: '删除高亮：{text}',
  highlightFailed: '高亮修改未完成，选中内容已保留，请重试',
  highlightRestartRequired: '当前后端尚未加载高亮保存接口，请重启项目服务后刷新页面',
} satisfies Record<string, string>

/** PDF translation keys shared by both dictionaries. */
export type PdfLocaleKey = keyof typeof zh

/** English PDF-renderer dictionary. */
export const en = {
  ...zoomEn,
  title: 'PDF',
  pageImage: 'PDF page {page}',
  loading: 'Rendering document...',
  rendering: 'Rendering page…',
  failed: 'Cannot display PDF: {message}',
  password: 'This PDF requires a password; password-protected previews are not supported.',
  workerFailed: 'The PDF rendering process could not continue. Please retry.',
  unsupported: 'PDF preview requires the complete file contents.',
  retry: 'Retry',
  highlightColors: 'Choose highlight color',
  yellow: 'Yellow highlight', green: 'Green highlight', blue: 'Blue highlight', pink: 'Pink highlight', orange: 'Orange highlight',
  highlightDismiss: 'Cancel',
  highlightDeleteHint: 'Click a highlight to remove it; double-click text to select a word',
  highlightActions: 'Highlight actions', highlightDelete: 'Remove highlight',
  translate: 'Translate', translationTitle: 'Selection translation', translationLoading: 'Translating with context…',
  translationHistory: 'Translation history', translationHistoryOpen: 'View translation history: {text}', translationHistoryClose: 'Close',
  translationHistoryVersions: 'Translations for this passage', translationHistoryVersion: 'Record {index}',
  translationHistoryFailed: 'Could not load translation history. Existing markers and content were retained. Retry to finish.',
  translationMeanings: 'General meanings', translationKeyMeaning: 'Key meanings', translationContextual: 'Meaning here', translationSentence: 'Original and translation',
  translationContext: 'View context · PDF page {page}', translationContextLimited: 'Fewer than two neighboring sentences are available, or this selection belongs to a separate heading, caption or similar block.',
  translationSpeak: 'Read aloud', translationStopSpeaking: 'Stop reading', translationSpeechHint: 'Reading uses your device’s English voice',
  translationDictionary: 'Phonetic source', translationPhoneticsUnavailable: 'Reliable phonetics are unavailable',
  translationPin: 'Pin', translationUnpin: 'Unpin', translationSave: 'Add to learning notes', translationSaving: 'Saving…', translationSaved: 'Added to notes',
  translationAsk: 'Ask Agent', translationInserted: 'The original and explanation are in the Agent composer. Add your question and send.',
  translationFailed: 'Translation did not complete. Your selection was retained. Retry to finish.', translationTimeout: 'Translation timed out. Your selection was retained. Retry to finish.',
  translationUnavailable: 'Choose an available model in this paper’s conversation, then retry.',
  translationSelectionFailed: 'This passage could not be located in the original. Select it again to translate.', translationNoText: 'The original has no readable text. Use a PDF with a text layer.',
  translationLimit: 'Translation exceeds a processing or storage limit. Select a shorter passage or adjust the backend translation limits, then retry.', translationSourceChanged: 'The original PDF changed. Reload the paper and select the text again.',
  translationSaveFailed: 'Could not add this translation to learning notes. Existing notes were retained. Retry to finish.',
  translationAskFailed: 'Could not insert into the Agent composer. Wait for the conversation to load and retry.',
  translationSpeakFailed: 'English reading is unavailable. Check your device’s voice settings and retry.',
  highlightRemove: 'Remove highlight: {text}',
  highlightFailed: 'The highlight change did not complete. Your selection was retained. Retry to finish it.',
  highlightRestartRequired: 'This backend has not loaded highlight saving. Restart the project server, then reload the page.',
} satisfies Record<PdfLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PDF page, loading, and failure messages. */
    sidebarPdf: PdfLocaleKey
  }
}
