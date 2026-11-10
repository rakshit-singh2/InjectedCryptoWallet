import { useState } from 'react';
import { Tabs } from 'antd';
import TokenList from '../Tabs/TokenList';
import NFTList from '../Tabs/NFTList';
import Transfer from '../Tabs/Transfer';
import TransactionHistory from '../Tabs/TransactionHistory';

const WalletViewContent = ({ account, network, onTransactionSent }) => {
  const [historyKey, setHistoryKey] = useState(0);
  const items = [
    {
      key: 'transfer',
      label: <span data-testid="wallet-tab-transfer">Send</span>,
      children: (
        <Transfer
          account={account}
          network={network}
          onSent={() => {
            setHistoryKey((key) => key + 1);
            onTransactionSent();
          }}
        />
      ),
    },
    {
      key: 'history',
      label: <span data-testid="wallet-tab-history">History</span>,
      children: <TransactionHistory key={historyKey} account={account} network={network} />,
    },
    {
      key: 'tokens',
      label: <span data-testid="wallet-tab-tokens">Tokens</span>,
      children: <TokenList account={account} network={network} />,
    },
    {
      key: 'nfts',
      label: <span data-testid="wallet-tab-nfts">NFTs</span>,
      children: <NFTList account={account} network={network} />,
    },
  ];

  return (
    <div className="content">
      <Tabs data-testid="wallet-content-tabs" defaultActiveKey="transfer" items={items} className="walletView" destroyInactiveTabPane />
    </div>
  );
};

export default WalletViewContent;
