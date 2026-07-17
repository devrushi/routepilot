/** RoutePilot service entrypoint. */

import { createApp } from './http/app';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const { app } = createApp();

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`RoutePilot listening on port ${port}`);
});
