import { runTicketProbeCli } from '../src/workflow/ticket_probe.js';

runTicketProbeCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
