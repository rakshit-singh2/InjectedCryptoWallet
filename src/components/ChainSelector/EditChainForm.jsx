import { useState } from 'react';
import { Form, Input, Button, message } from 'antd';
import { walletApi } from '../../helpers/walletApi';

const EditChainForm = ({ network, onSaved }) => {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);

  const handleEditChain = async (values) => {
    setBusy(true);
    try {
      await walletApi.editNetwork(network.chainId, {
        name: values.name,
        ticker: values.ticker,
        rpcUrl: values.rpcUrl,
        blockExplorerUrl: values.blockExplorerUrl || '',
      });
      message.success('Network updated');
      await onSaved();
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form
      form={form}
      onFinish={handleEditChain}
      layout="vertical"
      style={{ maxHeight: 'calc(60vh - 50px)', overflowY: 'auto' }}
      initialValues={{ name: network.name, ticker: network.ticker, rpcUrl: network.rpcUrl, blockExplorerUrl: network.blockExplorerUrl }}
    >
      <p>Chain ID {BigInt(network.chainId).toString()} ({network.chainId})</p>
      <Form.Item name="name" label="Network name" rules={[{ required: true, message: 'Enter a name' }]}>
        <Input data-testid="edit-chain-name-input" maxLength={64} />
      </Form.Item>
      <Form.Item name="ticker" label="Currency symbol" rules={[{ required: true, message: 'Enter the symbol' }]}>
        <Input data-testid="edit-chain-ticker-input" maxLength={12} />
      </Form.Item>
      <Form.Item name="rpcUrl" label="RPC URL" rules={[{ required: true, message: 'Enter the RPC URL' }]}>
        <Input data-testid="edit-chain-rpc-url-input" />
      </Form.Item>
      <Form.Item name="blockExplorerUrl" label="Block explorer URL (optional)">
        <Input data-testid="edit-chain-explorer-url-input" />
      </Form.Item>
      <Button data-testid="edit-chain-submit-button" type="primary" htmlType="submit" loading={busy} style={{ width: '100%' }}>
        Save
      </Button>
    </Form>
  );
};

export default EditChainForm;
