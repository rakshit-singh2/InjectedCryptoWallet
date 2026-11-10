import { Button } from 'antd';
import { useNavigate } from 'react-router';
import { BrandMark } from './Brand';

function Home() {
  const navigate = useNavigate();
  return (
    <div className="content homepage">
      <BrandMark size={84} />
      <h1 className="home-title">Welcome to Rakshit Wallet</h1>
      <p className="home-tagline">Your keys, your coins — a secure home for your Web3 accounts.</p>
      <ul className="home-points">
        <li>Keys are encrypted and never leave the wallet</li>
        <li>Every site, signature and transaction needs your approval</li>
        <li>Works with Ethereum, Polygon and custom networks</li>
      </ul>
      <Button data-testid="create-wallet-button" onClick={() => navigate('/create')} className="frontPageButton" type="primary" size="large">
        Create a new wallet
      </Button>
      <Button data-testid="recover-wallet-button" onClick={() => navigate('/recover')} className="frontPageButton" size="large">
        Import with recovery phrase
      </Button>
    </div>
  );
}

export default Home;
