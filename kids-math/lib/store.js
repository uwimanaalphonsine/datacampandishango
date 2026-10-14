// A small JSON-file database for accounts, sessions and children's work.
// Good for a family, a classroom or a small school; for many schools, move
// to a real database (the functions below are the only place to change).

import fs from "node:fs/promises";
import path from "node:path";

export class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.data = {};
    }
    this.data.users ??= {};
    this.data.sessions ??= {};
    return this;
  }

  // Writes are queued one after another and go through a temporary file, so
  // a crash mid-write never leaves a half-written database.
  save() {
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, json, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }

  findUserByEmail(email) {
    return Object.values(this.data.users).find((u) => u.email === email) || null;
  }

  getUser(id) {
    return this.data.users[id] || null;
  }
}
