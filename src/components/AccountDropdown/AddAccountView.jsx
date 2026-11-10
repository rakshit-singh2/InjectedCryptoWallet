import { Button } from 'antd';

const AddAccountView = ({ addChildAccount, handleImportAccountClick, busy }) => (
  <>
    <Button data-testid="add-derived-account-button" style={{ width: '100%', marginTop: 12 }} type="primary" loading={busy} onClick={addChildAccount}>
      Create new account
    </Button>
    <Button data-testid="open-import-account-button" style={{ width: '100%', marginTop: 12 }} onClick={handleImportAccountClick}>
      Import private key
    </Button>
  </>
);

export default AddAccountView;
