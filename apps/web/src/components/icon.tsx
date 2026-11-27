const paths = {
  home: 'M3 10l9-7 9 7v10H3z M9 20v-7h6v7',
  scan: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 8v8m3-8v8m4-8v8m3-8v8',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4m-9 4v10M8 5l9 4',
  list: 'M8 5H5v16h14V5h-3 M9 3h6v4H9z M8 11h8m-8 4h8',
  search: 'M21 21l-5-5 M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  tools: 'M9 3h6m-5 0v7l-5 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3M8 15h8',
  alert: 'M12 3l10 17H2z M12 9v4m0 3v.1',
  building: 'M3 21h18V8l-9-5-9 5z M7 21V11h10v10M7 15h10m-10 3h10',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5M8 13h8m-8 4h8',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
  users: 'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3m20 0v-3a4 4 0 0 0-3-4 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm4-4a4 4 0 0 1 0 8',
  help: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M9 9a3 3 0 1 1 5 2c-1 1-2 1.5-2 3m0 3v.1',
  sync: 'M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5m-4 7a8 8 0 0 0 14 2l3-3m0 5v-5h-5',
  image: 'M3 3h18v18H3z M3 17l5-5 4 4 3-3 6 6 M16 8h.01',
  bell: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',
  close: 'M6 6l12 12M18 6L6 18',
  torch: 'M9 3h6l2 5-3 4v9h-4v-9L7 8z M7 8h10',
  check: 'M5 12l4 4L19 6',
  next: 'M9 6l6 6-6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  sim: 'M7 3h7l5 5v13H7z M10 11h6v6h-6z M13 11v6m-3-3h6',
  pin: 'M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
} as const

export type IconName = keyof typeof paths

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  )
}
