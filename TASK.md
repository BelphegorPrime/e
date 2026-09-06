fix the following problem
<problem>
marcel@bierstube:~/n/bin$ e serve
/snapshot/e/node_modules/commander/lib/command.js:516
      return fn.apply(this, actionArgs);
                ^

Error: UI assets are missing at /snapshot/e/packages/cli/dist/ui. Build the UI before starting the server.
    at resolveUiDirectory (/snapshot/e/packages/cli/dist/serve/assets.js)
    at Command.<anonymous> (/snapshot/e/packages/cli/dist/serve/serve.js)
    at Command.listener [as _actionHandler] (/snapshot/e/node_modules/commander/lib/command.js:516:17)
    at /snapshot/e/node_modules/commander/lib/command.js:1375:20
    at Command._chainOrCall (/snapshot/e/node_modules/commander/lib/command.js:1283:12)
    at Command._parseCommand (/snapshot/e/node_modules/commander/lib/command.js:1373:27)
    at /snapshot/e/node_modules/commander/lib/command.js:1184:27
    at Command._chainOrCall (/snapshot/e/node_modules/commander/lib/command.js:1283:12)
    at Command._dispatchSubcommand (/snapshot/e/node_modules/commander/lib/command.js:1180:25)
    at Command._parseCommand (/snapshot/e/node_modules/commander/lib/command.js:1343:19)

Node.js v24.18.1
</problem>

would it be better to move the ui workspace into the cli workspace? Or remove all workplaces and have one monolith?
