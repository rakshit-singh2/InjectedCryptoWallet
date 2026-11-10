import './App.css';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Alert, Button, Spin } from 'antd';
import Home from './components/Home';
import CreateWallet from './components/CreateWallet';
import RecoverWallet from './components/RecoverWallet';
import WalletView from './components/WalletView/WalletView';
import EnterPassword from './components/EnterPassword';
import ResetPassword from './components/ResetPassword';
import ApprovalRequest from './components/ApprovalRequest';
import ConnectionManager from './components/ConnectionManager';
import Settings from './components/Settings';
import { BrandLogo } from './components/Brand';
import { walletApi, isExtensionContext } from './helpers/walletApi';
import { clearLegacyLocalStorage, getLegacySeedRecord } from './helpers/legacyVault';

const ACTIVITY_PING_MIN_INTERVAL_MS = 30_000;

function App() {
  const location = useLocation();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const next = await walletApi.getState();
      setState(next);
      setError('');
      if (next.initialized) {
        clearLegacyLocalStorage(); // idempotent clean-up after a successful upgrade
      }
      return next;
    } catch (refreshError) {
      setError(refreshError.message);
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reset the auto-lock timer only on real user input (not merely because the popup is open).
  useEffect(() => {
    if (!state?.unlocked) {
      return undefined;
    }
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last >= ACTIVITY_PING_MIN_INTERVAL_MS) {
        last = now;
        walletApi.touch().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', onActivity, true);
    window.addEventListener('keydown', onActivity, true);
    return () => {
      window.removeEventListener('pointerdown', onActivity, true);
      window.removeEventListener('keydown', onActivity, true);
    };
  }, [state?.unlocked]);

  const header = (
    <div className="headers">
      <BrandLogo size={30} />
    </div>
  );

  if (!isExtensionContext()) {
    return (
      <div className="App">
        {header}
        <Alert type="warning" showIcon message="Load the built extension (dist/) in a Chromium browser to use the wallet." />
      </div>
    );
  }

  if (location.pathname === '/approval') {
    return (
      <div className="App approval-app">
        <ApprovalRequest />
      </div>
    );
  }

  if (!state) {
    return (
      <div className="App">
        {header}
        {error ? (
          <Alert
            type="error"
            showIcon
            message={error}
            action={<Button data-testid="app-retry-button" size="small" onClick={refresh}>Retry</Button>}
          />
        ) : (
          <Spin size="large" />
        )}
      </div>
    );
  }

  let routes;
  if (!state.initialized) {
    const legacyRecord = getLegacySeedRecord();
    routes = legacyRecord ? (
      <Route path="*" element={<EnterPassword mode="migrate" legacyRecord={legacyRecord} onDone={refresh} />} />
    ) : (
      <>
        <Route path="/" element={<Home />} />
        <Route path="/create" element={<CreateWallet onDone={refresh} />} />
        <Route path="/recover" element={<RecoverWallet onDone={refresh} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </>
    );
  } else if (!state.unlocked) {
    routes = (
      <>
        <Route path="/" element={<EnterPassword mode="unlock" onDone={refresh} />} />
        <Route path="/resetPassword" element={<ResetPassword onDone={refresh} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </>
    );
  } else {
    routes = (
      <>
        <Route path="/" element={<WalletView state={state} refresh={refresh} />} />
        <Route path="/connections" element={<ConnectionManager />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </>
    );
  }

  return (
    <div className="App">
      {header}
      <Routes>{routes}</Routes>
    </div>
  );
}

export default App;
