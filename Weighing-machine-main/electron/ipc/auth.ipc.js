'use strict';

const OperatorAuthService = require('../../backend/services/OperatorAuthService');

const NAMESPACE = 'auth';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:verifyPin`, async (_e, pin) =>
    OperatorAuthService.verifyPin(pin),
  );

  ipcMain.handle(`${NAMESPACE}:verifyAdvanceGate`, async (_e, pin) =>
    OperatorAuthService.verifyAdvanceGate(pin),
  );

  ipcMain.handle(`${NAMESPACE}:lockAdvanced`, async () =>
    OperatorAuthService.lockAdvanced(),
  );

  ipcMain.handle(`${NAMESPACE}:getSession`, async () =>
    OperatorAuthService.getSession(),
  );

  ipcMain.handle(`${NAMESPACE}:verifyManualHywaPin`, async (_e, pin) =>
    OperatorAuthService.verifyManualHywaPin(pin),
  );

  ipcMain.handle(`${NAMESPACE}:lockManualHywaClose`, async () =>
    OperatorAuthService.lockManualHywaClose(),
  );

  ipcMain.handle(`${NAMESPACE}:getManualHywaCloseSession`, async () =>
    OperatorAuthService.getManualHywaCloseSession(),
  );

  ipcMain.handle(`${NAMESPACE}:verifyEngineeringPin`, async (_e, pin) =>
    OperatorAuthService.verifyEngineeringPin(pin),
  );

  ipcMain.handle(`${NAMESPACE}:lockEngineeringConsole`, async () =>
    OperatorAuthService.lockEngineeringConsole(),
  );

  ipcMain.handle(`${NAMESPACE}:getEngineeringSession`, async () =>
    OperatorAuthService.getEngineeringSession(),
  );
}

module.exports = { register, NAMESPACE };
