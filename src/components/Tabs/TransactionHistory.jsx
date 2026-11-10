import { useEffect, useState } from 'react';
import { Alert, List, Spin, Typography } from 'antd';
import { getTransactions } from '../../shared/assetStore';
import { formatAmount, shortAddress } from '../../helpers/rpc';
import CopyButton from '../CopyButton';

const { Text } = Typography;

const TransactionHistory = ({ account, network }) => {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const { chainId, name } = network;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTransactions(account.address, { chainId, name })
      .then((txs) => !cancelled && setTransactions(txs))
      .catch(() => !cancelled && setError('Could not load transaction history.'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [account.address, chainId, name]);

  if (loading) {
    return <Spin />;
  }
  if (error) {
    return <Alert type="error" showIcon message={error} />;
  }
  if (!transactions.length) {
    return <Text>No transactions yet</Text>;
  }

  return (
    <List
      bordered
      dataSource={transactions}
      renderItem={(item) => (
        <List.Item key={item.transactionHash}>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <Text strong>{shortAddress(item.transactionHash)}</Text>
            <br />
            <Text type="secondary">To {item.to ? shortAddress(item.to) : 'contract creation'}</Text>
            <br />
            <Text>{formatAmount(item.amount)} {network.ticker}</Text>
            {item.origin && item.origin !== 'wallet' && (
              <>
                <br />
                <Text type="secondary">via {item.origin}</Text>
              </>
            )}
          </div>
          <div>
            <CopyButton content={item.transactionHash} testId={`copy-transaction-hash-${item.transactionHash}`} label="Copy transaction hash" />
            {network.blockExplorerUrl && (
              <a
                data-testid={`transaction-explorer-link-${item.transactionHash}`}
                href={`${network.blockExplorerUrl}/tx/${item.transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View
              </a>
            )}
          </div>
        </List.Item>
      )}
    />
  );
};

export default TransactionHistory;
