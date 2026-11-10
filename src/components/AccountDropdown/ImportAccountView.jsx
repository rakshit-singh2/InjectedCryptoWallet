import { useState } from 'react';
import { Alert, Button, Input } from 'antd';

const ImportAccountView = ({ onImport, busy }) => {
  const [privateKey, setPrivateKey] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onImport(privateKey);
        setPrivateKey('');
      }}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Imported accounts are not covered by your recovery phrase. Keep a separate backup of this key."
      />
      <Input.Password
        data-testid="import-private-key-input"
        aria-label="Private key"
        value={privateKey}
        onChange={(e) => setPrivateKey(e.target.value)}
        placeholder="Private key (hex)"
        autoComplete="off"
      />
      <Button data-testid="import-private-key-submit-button" type="primary" htmlType="submit" loading={busy} disabled={!privateKey} style={{ width: '100%', marginTop: 12 }}>
        Import Account
      </Button>
    </form>
  );
};

export default ImportAccountView;
