/** Texts of the built-in UI (the formatting toolbar of the text editor), for translation. */
export interface BoardLabels {
  font: string;
  smaller: string;
  fontSize: string;
  bigger: string;
  bold: string;
  italic: string;
  underline: string;
  strike: string;
  link: string;
  bulletList: string;
  orderedList: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  textColor: string;
  linkPlaceholder: string;
  applyLink: string;
  removeLink: string;
  /** Tooltip line under a link's address in the editor. */
  openLinkHint: string;
}

export const EN_LABELS: BoardLabels = {
  font: 'Font',
  smaller: 'Smaller (Ctrl+Shift+<)',
  fontSize: 'Font size (of the selection, or the whole text)',
  bigger: 'Bigger (Ctrl+Shift+>)',
  bold: 'Bold (Ctrl+B)',
  italic: 'Italic (Ctrl+I)',
  underline: 'Underline (Ctrl+U)',
  strike: 'Strikethrough (Ctrl+Shift+X)',
  link: 'Link (Ctrl+K)',
  bulletList: 'Bulleted list (Ctrl+Shift+8, or "- " at the start of a line)',
  orderedList: 'Numbered list (Ctrl+Shift+7, or "1. " at the start of a line)',
  alignLeft: 'Align left',
  alignCenter: 'Align center',
  alignRight: 'Align right',
  textColor: 'Text color',
  linkPlaceholder: 'https://… or e-mail',
  applyLink: 'Apply (Enter)',
  removeLink: 'Remove link',
  openLinkHint: 'Ctrl+click to open',
};

export const RU_LABELS: BoardLabels = {
  font: 'Шрифт',
  smaller: 'Меньше (Ctrl+Shift+<)',
  fontSize: 'Размер шрифта (выделенного текста или всего)',
  bigger: 'Больше (Ctrl+Shift+>)',
  bold: 'Жирный (Ctrl+B)',
  italic: 'Курсив (Ctrl+I)',
  underline: 'Подчёркнутый (Ctrl+U)',
  strike: 'Зачёркнутый (Ctrl+Shift+X)',
  link: 'Ссылка (Ctrl+K)',
  bulletList: 'Маркированный список (Ctrl+Shift+8, или «- » в начале строки)',
  orderedList: 'Нумерованный список (Ctrl+Shift+7, или «1. » в начале строки)',
  alignLeft: 'По левому краю',
  alignCenter: 'По центру',
  alignRight: 'По правому краю',
  textColor: 'Цвет текста',
  linkPlaceholder: 'https://… или e-mail',
  applyLink: 'Применить (Enter)',
  removeLink: 'Убрать ссылку',
  openLinkHint: 'Ctrl+клик — открыть',
};
