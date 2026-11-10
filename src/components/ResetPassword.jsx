import { useState } from 'react';
import { BulbOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Input, message } from 'antd';
import { useNavigate } from 'react-router';
import { Mnemonic } from 'ethers';
import SetPassword from './SetPassword';
import { normalizePhrase } from './RecoverWallet';
import { walletApi } from '../helpers/walletApi';

const { TextArea } = Input;

function ResetPassword({ onDone }) {
  const navigate = useNavigate();
  const [typedSeed, setTypedSeed] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importedAccounts, setImportedAccounts] = useState(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [pendingPassword, setPendingPassword] = useState(null);

  const phrase = normalizePhrase(typedSeed);
  const valid = phrase.length > 0 && Mnemonic.isValidMnemonic(phrase);

  const reset = async (password, confirmDropImported = false) => {
    setBusy(true);
    setError('');
    try {
      await walletApi.resetWithMnemonic(phrase, password, confirmDropImported);
      setTypedSeed('');
      setPendingPassword(null);
      message.success('Password reset');
      await onDone();
      navigate('/');
    } catch (resetError) {
      if (Array.isArray(resetError.data?.importedAccounts)) {
        setImportedAccounts(resetError.data.importedAccounts);
        setPendingPassword(password);
      } else {
        setError(resetError.message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (importedAccounts && pendingPassword) {
    return (
      <div className="content">
        <Alert
          type="warning"
          showIcon
          message="Imported accounts will be removed"
          description={
            <>
              <p>These accounts were imported with a private key and are not derived from your recovery phrase. Without the old password they cannot be recovered. Re-import them afterwards if you have their keys.</p>
              <ul style={{ paddingLeft: 16, wordBreak: 'break-all' }}>
                {importedAccounts.map((address) => <li key={address}>{address}</li>)}
              </ul>
            </>
          }
        />
        <Checkbox data-testid="reset-confirm-drop-imported-checkbox" checked={confirmDrop} onChange={(e) => setConfirmDrop(e.target.checked)}>
          I understand these accounts will be removed
        </Checkbox>
        {error && <Alert type="error" showIcon message={error} />}
        <Button data-testid="reset-confirm-drop-imported-button" danger type="primary" disabled={!confirmDrop} loading={busy} onClick={() => reset(pendingPassword, true)}>
          Reset password
        </Button>
        <Button data-testid="reset-cancel-button" type="link" onClick={() => navigate('/')}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="mnemonic">
        <BulbOutlined style={{ fontSize: 20 }} />
        <div>Enter the wallet&apos;s recovery phrase and choose a new password.</div>
      </div>
      <TextArea
        data-testid="reset-password-seed-input"
        aria-label="Recovery phrase"
        value={typedSeed}
        onChange={(e) => setTypedSeed(e.target.value)}
        className="seedPhraseContainer"
        placeholder="Recovery phrase"
        autoComplete="off"
        spellCheck={false}
        autoSize={{ minRows: 3, maxRows: 5 }}
      />
      {error && <Alert type="error" showIcon message={error} style={{ margin: '8px 0' }} />}
      {valid && <SetPassword onSubmit={(password) => reset(password)} submitLabel="Reset Password" busy={busy} />}
      <Button data-testid="reset-password-login-link" type="link" onClick={() => navigate('/')}>
        Back to unlock
      </Button>
    </div>
  );
}

export default ResetPassword;
