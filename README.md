# 發條森衛 · Clockwork Wardens

Original browser strategy game: arrange two-cell guardian gears, connect them to the golden core, and defend a forest wall over twelve waves.

## Play

- Buy a guardian, then click an empty grid cell. Use Rotate / R to change its two-cell footprint.
- Click a placed guardian then an empty cell, or drag it, to move it during preparation.
- Adjacent gears transfer power. Disconnected guardians do not fire. Guardians closer to the core get a small power bonus.
- Upgrade, recycle for a partial refund, or repair before the next wave.
- Four roles: precise laser, chain lightning, area shells, slowing frost. Bosses arrive on waves 4, 8, 12.
- Pause, speed and sound controls, restart, and browser-local preparation checkpoints are included.

No external fonts, libraries, accounts, trackers, or paid assets. All illustrations are original vector/canvas artwork.

## Development

Buildless ES modules. Serve this directory over HTTP. `npm test` runs deterministic engine tests with Node.js. The public site uses GitHub Pages from main / root.

The browser saves only game progress and preferences on this device. Clearing browser site data clears progress.
