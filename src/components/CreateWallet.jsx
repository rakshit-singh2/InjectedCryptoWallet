import { useState } from 'react';
import { Alert, Button, Card, Checkbox, message } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router';
import { Mnemonic } from 'ethers';
import SetPassword from './SetPassword';
import { walletApi } from '../helpers/walletApi';

function generateMnemonic() {
  return Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16))).phrase;
}

function CreateWallet({ onDone }) {
  const navigate = useNavigate();
  // The phrase lives only in component state; it is never written to browser storage by the popup.
  const [phrase, setPhrase] = useState(null);
  const [saved, setSaved] = useState(false);
  const [step, setStep] = useState('reveal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (password) => {
    setBusy(true);
    setError('');
    try {
      await walletApi.createVault(phrase, password);
      setPhrase(null);
      message.success('Wallet created');
      await onDone();
      navigate('/');
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'password') {
    return (
      <div className="content">
        <h3>Protect your wallet</h3>
        <p>This password unlocks the wallet on this device only.</p>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <SetPassword onSubmit={create} submitLabel="Create Wallet" busy={busy} />
        <Button data-testid="create-wallet-back-to-phrase" type="link" onClick={() => setStep('reveal')}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="mnemonic">
        <ExclamationCircleOutlined style={{ fontSize: 20 }} />
        <div>Write the recovery phrase down and keep it offline. Anyone with it controls your funds.</div>
      </div>
      <Button data-testid="generate-seed-phrase-button" className="frontPageButton" type="primary" onClick={() => setPhrase(generateMnemonic())}>
        {phrase ? 'Generate a different phrase' : 'Generate Recovery Phrase'}
      </Button>
      <Card className="seedPhraseContainer">
        {phrase && <pre data-testid="generated-seed-phrase" style={{ whiteSpace: 'pre-wrap' }}>{phrase}</pre>}
      </Card>
      <Checkbox data-testid="seed-phrase-saved-checkbox" checked={saved} disabled={!phrase} onChange={(e) => setSaved(e.target.checked)}>
        I have saved my recovery phrase
      </Checkbox>
      <Button
        data-testid="open-wallet-button"
        className="frontPageButton"
        type="default"
        disabled={!phrase || !saved}
        onClick={() => setStep('password')}
      >
        Continue
      </Button>
      <Button data-testid="create-wallet-back-home" type="link" onClick={() => navigate('/')}>
        Back Home
      </Button>
    </div>
  );
}

export default CreateWallet;
