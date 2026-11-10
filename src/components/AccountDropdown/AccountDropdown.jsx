import { useState } from 'react';
import { Button, Modal, Tooltip, message } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import AccountDetailsView from './AccountDetailsView';
import AddAccountView from './AddAccountView';
import ImportAccountView from './ImportAccountView';
import AccountList from './AccountList';
import { walletApi } from '../../helpers/walletApi';
import { shortAddress } from '../../helpers/rpc';

const AccountDropdown = ({ state, refresh, network }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('list'); // list | add | import | details
  const [detailsAddress, setDetailsAddress] = useState(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setView('list');
    setDetailsAddress(null);
  };

  const run = async (action, successText) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      if (successText) {
        message.success(successText);
      }
      close();
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const titles = { list: 'Select an Account', add: 'Add Account', import: 'Import Account', details: 'Account Details' };
  const detailsAccount = state.accounts.find((account) => account.address === detailsAddress);

  return (
    <>
      <Button data-testid="account-selector-button" shape="round" size="small" style={{ height: 30, paddingInline: 10 }} onClick={() => setOpen(true)} icon={<UserOutlined />}>
        <Tooltip title={state.selectedAddress}>{shortAddress(state.selectedAddress)}</Tooltip>
      </Button>
      <Modal title={titles[view]} open={open} onCancel={close} footer={null} width={320} centered destroyOnClose>
        {view === 'details' && detailsAccount ? (
          <AccountDetailsView account={detailsAccount} network={network} refresh={refresh} />
        ) : view === 'add' ? (
          <AddAccountView
            busy={busy}
            addChildAccount={() => run(() => walletApi.addAccount(), 'Account added')}
            handleImportAccountClick={() => setView('import')}
          />
        ) : view === 'import' ? (
          <ImportAccountView busy={busy} onImport={(privateKey) => run(() => walletApi.importAccount(privateKey), 'Account imported')} />
        ) : (
          <AccountList
            accounts={state.accounts}
            selectedAddress={state.selectedAddress}
            network={network}
            onSelect={(address) => run(() => walletApi.selectAccount(address))}
            onDetails={(address) => {
              setDetailsAddress(address);
              setView('details');
            }}
            onAdd={() => setView('add')}
          />
        )}
      </Modal>
    </>
  );
};

export default AccountDropdown;
