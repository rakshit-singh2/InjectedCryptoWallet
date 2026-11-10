import { useState } from 'react';
import { Alert, Button, Card, Input, Typography } from 'antd';
import { Link } from 'react-router';
import { walletApi } from '../helpers/walletApi';
import { clearLegacyLocalStorage } from '../helpers/legacyVault';
import { BrandMark } from './Brand';

const { Title, Paragraph } = Typography;

/**
 * mode="unlock":  normal unlock.
 * mode="migrate": first unlock after upgrading from the popup-storage layout. The encrypted legacy
 *                 record is passed to the background, which re-encrypts everything into its vault.
 */
function EnterPassword({ mode = 'unlock', legacyRecord, onDone, compact = false }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'migrate') {
        await walletApi.migrateLegacy(password, legacyRecord);
        clearLegacyLocalStorage();
      } else {
        await walletApi.unlock(password);
      }
      setPassword('');
      await onDone?.();
    } catch (unlockError) {
      setError(unlockError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="enter-password-container">
      <Card bordered={false} style={{ width: compact ? '100%' : 320, margin: 'auto' }}>
        {!compact && (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
            <BrandMark size={56} />
          </div>
        )}
        <Title level={3} style={{ textAlign: 'center' }}>
          {mode === 'migrate' ? 'Upgrade your wallet' : 'Welcome back'}
        </Title>
        {mode === 'unlock' && (
          <Paragraph type="secondary" style={{ textAlign: 'center' }}>
            Enter your password to unlock Rakshit Wallet.
          </Paragraph>
        )}
        {mode === 'migrate' && (
          <Paragraph type="secondary">
            Enter your existing password once to move your accounts into the extension&apos;s secure vault.
          </Paragraph>
        )}
        <form onSubmit={submit}>
          <Input.Password
            data-testid="wallet-password-input"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            autoFocus
            style={{ marginBottom: 12 }}
          />
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          <Button data-testid="unlock-wallet-button" type="primary" htmlType="submit" block loading={busy} disabled={!password}>
            {mode === 'migrate' ? 'Upgrade and unlock' : 'Unlock'}
          </Button>
        </form>
      </Card>
      {mode === 'unlock' && !compact && (
        <Link data-testid="forgot-password-link" to="/resetPassword">
          Forgot password? Restore with recovery phrase
        </Link>
      )}
    </div>
  );
}

export default EnterPassword;
