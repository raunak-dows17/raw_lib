# Examples

Runnable examples that show the full stack — RawQL, RawVal, and RawAuth — behind three HTTP
frameworks. Each example is standalone: it has its own `package.json` and uses the in-memory
adapter so there is nothing to install besides Node.js.

```bash
cd examples/express
npm install
npm run dev
```

All three expose the same routes:

| Method | Route            | Purpose                            |
| ------ | ---------------- | ---------------------------------- |
| `POST` | `/auth/register` | Create a user and start a session  |
| `POST` | `/auth/login`    | Password login                     |
| `POST` | `/auth/refresh`  | Rotate the refresh token           |
| `POST` | `/auth/logout`   | Revoke the session                 |
| `GET`  | `/me`            | Verify the access token            |
| `GET`  | `/users`         | List users without password hashes |

Send `Authorization: Bearer <accessToken>` to protected routes and `x-device-id` when you want
strict device binding. Replace `MemoryAdapter` with `mongo()` from `raw_lib/mongo` to persist
data; the application code does not change.

> The examples target `raw_lib@2`. Until the release is published, point `raw_lib` at the
> repository (`"raw_lib": "file:../.."`) or run `npm link` from the project root.
