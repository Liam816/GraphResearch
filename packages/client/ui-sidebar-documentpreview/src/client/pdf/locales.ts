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
  highlightDeleteHint: '双击高亮删除',
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
  highlightDeleteHint: 'Double-click a highlight to remove it',
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
