import { useEffect, useState } from 'react';
import { Alert, Button, Input, Typography, message } from 'antd';
import QRCodeGenerator from '../QRCodeGenerator/QRCodeGenerator';
import { walletApi } from '../../helpers/walletApi';

const { Paragraph, Text } = Typography;
const REVEAL_SECONDS = 60;

const AccountDetailsView = ({ account, refresh }) => {
  const [name, setName] = useState(account.name);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Hide a revealed key automatically and whenever this view unmounts.
  useEffect(() => {
    if (!privateKey) {
      return undefined;
    }
    const timer = setTimeout(() => setPrivateKey(''), REVEAL_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [privateKey]);

  const rename = async () => {
    try {
      await walletApi.renameAccount(account.address, name);
      await refresh();
      message.success('Account renamed');
    } catch (renameError) {
      message.error(renameError.message);
    }
  };

  const reveal = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setPrivateKey(await walletApi.exportPrivateKey(account.address, password));
    } catch (revealError) {
      setError(revealError.message);
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div>
      <QRCodeGenerator walletAddress={account.address} />
      <Paragraph copyable style={{ wordBreak: 'break-all' }}>{account.address}</Paragraph>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Input data-testid="account-rename-input" aria-label="Account name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        <Button data-testid="account-rename-button" onClick={rename} disabled={!name.trim() || name === account.name}>
          Rename
        </Button>
      </div>
      {privateKey ? (
        <>
          <Alert type="warning" showIcon message="Never share this key. Anyone with it can take your funds." style={{ marginBottom: 8 }} />
          <Text data-testid="revealed-private-key" code copyable style={{ wordBreak: 'break-all' }}>{privateKey}</Text>
          <Button data-testid="toggle-private-key-button" block style={{ marginTop: 8 }} onClick={() => setPrivateKey('')}>
            Hide private key
          </Button>
        </>
      ) : (
        <form onSubmit={reveal}>
          <Input.Password
            data-testid="export-key-password-input"
            aria-label="Password to reveal private key"
            placeholder="Password to reveal private key"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
          <Button data-testid="toggle-private-key-button" htmlType="submit" block loading={busy} disabled={!password} style={{ marginTop: 8 }}>
            Show private key
          </Button>
        </form>
      )}
    </div>
  );
};

export default AccountDetailsView;
