import QRCode from 'qrcode.react';

const QRCodeGenerator = ({ walletAddress }) => {
    return (
        <div>
            <h3>Scan to Send Funds</h3>
            <QRCode value={`ethereum:${walletAddress}`} size={128} />
        </div>
    );
};

export default QRCodeGenerator;
