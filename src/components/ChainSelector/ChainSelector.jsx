import { useState } from 'react';
import { Button, Modal, message } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import ChainList from './ChainList';
import AddChainForm from './AddChainForm';
import EditChainForm from './EditChainForm';
import { walletApi } from '../../helpers/walletApi';
import { networkIcon } from '../../helpers/rpc';

const ChainSelector = ({ state, refresh }) => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('list'); // list | add | edit
  const [editing, setEditing] = useState(null);
  const selected = state.networks[state.selectedChainId];

  const close = () => {
    setOpen(false);
    setView('list');
    setEditing(null);
  };

  const select = async (chainId) => {
    try {
      await walletApi.selectNetwork(chainId);
      await refresh();
      close();
    } catch (error) {
      message.error(error.message);
    }
  };

  const remove = async (network) => {
    try {
      await walletApi.removeNetwork(network.chainId);
      await refresh();
      message.success(`${network.name} removed`);
    } catch (error) {
      message.error(error.message);
    }
  };

  return (
    <>
      <Button data-testid="network-selector-button" aria-label={`Network: ${selected?.name ?? 'none'}`} onClick={() => setOpen(true)} shape="round" size="small" style={{ height: 32, paddingInline: 8 }}>
        <img src={networkIcon(selected)} alt="" style={{ width: 18, height: 18 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <DownOutlined />
      </Button>
      <Modal title={view === 'add' ? 'Add Network' : view === 'edit' ? 'Edit Network' : 'Select a Network'} open={open} onCancel={close} footer={null} width={320} centered destroyOnClose>
        {view === 'edit' && editing ? (
          <EditChainForm
            network={editing}
            onSaved={async () => {
              await refresh();
              setView('list');
            }}
          />
        ) : view === 'add' ? (
          <AddChainForm
            onSaved={async () => {
              await refresh();
              setView('list');
            }}
          />
        ) : (
          <ChainList
            networks={Object.values(state.networks)}
            selectedChainId={state.selectedChainId}
            onSelect={select}
            onEdit={(network) => {
              setEditing(network);
              setView('edit');
            }}
            onRemove={remove}
            onAdd={() => setView('add')}
          />
        )}
      </Modal>
    </>
  );
};

export default ChainSelector;
