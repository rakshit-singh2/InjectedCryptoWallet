import { useState } from 'react';
import { BulbOutlined } from '@ant-design/icons';
import { Alert, Button, Input, message } from 'antd';
import { useNavigate } from 'react-router';
import { Mnemonic } from 'ethers';
import SetPassword from './SetPassword';
import { walletApi } from '../helpers/walletApi';

const { TextArea } = Input;

export const normalizePhrase = (value) => value.trim().toLowerCase().split(/\s+/).join(' ');

function RecoverWallet({ onDone }) {
  const navigate = useNavigate();
  const [typedSeed, setTypedSeed] = useState('');
  const [step, setStep] = useState('phrase');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const phrase = normalizePhrase(typedSeed);
  const valid = phrase.length > 0 && Mnemonic.isValidMnemonic(phrase);

  const recover = async (password) => {
    setBusy(true);
    setError('');
    try {
      await walletApi.createVault(phrase, password);
      setTypedSeed('');
      message.success('Wallet imported');
      await onDone();
      navigate('/');
    } catch (recoverError) {
      setError(recoverError.message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'password') {
    return (
      <div className="content">
        <h3>Set a password</h3>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <SetPassword onSubmit={recover} submitLabel="Import Wallet" busy={busy} />
        <Button data-testid="recover-back-to-phrase" type="link" onClick={() => setStep('phrase')}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="mnemonic">
        <BulbOutlined style={{ fontSize: 20 }} />
        <div>Enter your 12–24 word recovery phrase, separated by spaces.</div>
      </div>
      <TextArea
        data-testid="recover-seed-phrase-input"
        aria-label="Recovery phrase"
        value={typedSeed}
        onChange={(e) => setTypedSeed(e.target.value)}
        className="seedPhraseContainer"
        placeholder="Recovery phrase"
        autoComplete="off"
        spellCheck={false}
        autoSize={{ minRows: 3, maxRows: 5 }}
      />
      {typedSeed && !valid && <p style={{ color: '#cf1322' }}>This is not a valid recovery phrase yet.</p>}
      <Button data-testid="recover-wallet-submit-button" disabled={!valid} className="frontPageButton" type="primary" onClick={() => setStep('password')}>
        Continue
      </Button>
      <Button data-testid="recover-back-home" type="link" onClick={() => navigate('/')}>
        Back Home
      </Button>
    </div>
  );
}

export default RecoverWallet;
