export interface DashboardIcon { path: string; accent?: string; dots?: readonly (readonly [number, number, number])[]; dashed?: boolean }
export const DASHBOARD_ICONS: Readonly<Record<string, DashboardIcon>> = {
  "stage-local": {
    "path": "M7 4.5h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-7a4 4 0 0 1 4-4ZM8 10l3 2.5L8 15",
    "dots": [
      [
        14.9,
        15.1,
        1.6
      ]
    ]
  },
  "stage-loop": {
    "path": "M5 12a7 7 0 0 1 11.95-4.95M16.95 3.5v3.55H13.4M19 12a7 7 0 0 1-11.95 4.95M7.05 20.5v-3.55h3.55",
    "dots": [
      [
        12,
        12,
        1.8
      ]
    ]
  },
  "stage-verify": {
    "path": "M12 3 19 5.8v5.5c0 4.2-2.9 7.5-7 9.2-4.1-1.7-7-5-7-9.2V5.8L12 3Z",
    "accent": "m8.9 11.9 2.3 2.3 4.1-4.5"
  },
  "stage-ready": {
    "path": "M12 7.6v12.9M8.6 11.4h6.8M5 13.5a7 7 0 0 0 14 0",
    "accent": "M12 3.3a2.15 2.15 0 1 1 0 4.3 2.15 2.15 0 0 1 0-4.3Z"
  },
  "stage-unknown": {
    "path": "M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6Z",
    "dots": [
      [
        12,
        12,
        1.7
      ]
    ],
    "dashed": true
  },
  "state-human": {
    "path": "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM9.6 9.7a2.5 2.5 0 0 1 4.8.9c0 1.8-2.4 2.2-2.4 3.7",
    "dots": [
      [
        12,
        16.9,
        1.25
      ]
    ]
  },
  "state-ready": {
    "path": "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z",
    "accent": "m8.6 12.2 2.4 2.4 4.4-4.9"
  },
  "state-handoff": {
    "path": "M21 3 3.5 10.2l6.8 2.9 3.2 6.9L21 3Z",
    "accent": "M10.3 13.1 21 3"
  },
  "state-pause": {
    "path": "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM10 9.4v5.2M14 9.4v5.2"
  },
  "state-unknown": {
    "path": "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z",
    "accent": "M12 7.8V12l3 1.9"
  },
  "search": {
    "path": "M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12ZM15 15l5 5"
  },
  "close": {
    "path": "M6.5 6.5l11 11M17.5 6.5l-11 11"
  },
  "check": {
    "path": "M5.5 12.5l4.2 4.2L18.5 7.8"
  },
  "chevron": {
    "path": "M6.5 9.5 12 15l5.5-5.5"
  },
  "arrow": {
    "path": "M5 12h13M13 6.5 18.5 12 13 17.5"
  },
  "session": {
    "path": "M6.5 4.5h11a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-5.2L8 20v-3.5H6.5a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3Z",
    "dots": [
      [
        8.4,
        10.5,
        1.05
      ],
      [
        12,
        10.5,
        1.05
      ],
      [
        15.6,
        10.5,
        1.05
      ]
    ]
  },
  "alert": {
    "path": "M12 4.2 20.3 18.8H3.7L12 4.2ZM12 10.2v3.4",
    "dots": [
      [
        12,
        16.4,
        1.25
      ]
    ]
  },
  "board": {
    "path": "M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM9.5 4.5v15M14.5 4.5v15",
    "dots": [
      [
        6.6,
        9,
        1
      ]
    ]
  }
};
