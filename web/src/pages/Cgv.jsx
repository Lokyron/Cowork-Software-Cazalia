import { Link } from 'react-router-dom';
import BackLink from '../components/BackLink.jsx';

// Conditions Générales de Vente (CGV) - distinctes des CGU (usage du Service).
// Elles encadrent la RÉSERVATION et le paiement d'espaces, ainsi que les
// abonnements, pour les consommateurs (B2C) comme pour les professionnels (B2B).
// À compléter : coordonnées du médiateur de la consommation (art. 11) une fois
// l'adhésion souscrite - cf. docs/juridique/AUDIT-JURIDIQUE.md §5.6.
export default function Cgv() {
  return (
    <div className="legal">
      <BackLink to="/" label="Retour à l'accueil" />
      <img src="/images/logo-cazalia.svg" className="legal-logo" alt="CAZALIA - Coworking Boutonnet" />
      <h1>Conditions générales de vente</h1>
      <p className="muted">Dernière mise à jour : novembre 2026.</p>

      <p>
        Les présentes conditions générales de vente (les « <strong>CGV</strong> ») régissent la réservation
        et le paiement d'espaces de coworking, ainsi que les abonnements, proposés par CAZALIA. Elles complètent les{' '}
        <Link to="/cgu">conditions générales d'utilisation</Link> (qui encadrent l'usage du service et
        contiennent les mentions légales et la politique de confidentialité). En cas de contradiction sur
        un point de vente, les présentes CGV prévalent.
      </p>

      <nav className="legal-toc" aria-label="Sommaire">
        <p><strong>Sommaire</strong></p>
        <ol>
          <li><a href="#identite">Identité du vendeur</a></li>
          <li><a href="#champ">Champ d'application (B2C / B2B)</a></li>
          <li><a href="#offres">Offres et prix</a></li>
          <li><a href="#commande">Commande et formation du contrat</a></li>
          <li><a href="#paiement">Paiement</a></li>
          <li><a href="#facturation">Facturation et TVA</a></li>
          <li><a href="#retractation">Droit de rétractation (consommateurs)</a></li>
          <li><a href="#annulation">Annulation, report et remboursement</a></li>
          <li><a href="#retard">Retard de paiement (professionnels)</a></li>
          <li><a href="#responsabilite">Responsabilité et force majeure</a></li>
          <li><a href="#mediation">Réclamations et médiation</a></li>
          <li><a href="#droit">Droit applicable et litiges</a></li>
        </ol>
      </nav>

      <h2 id="identite">1. Identité du vendeur</h2>
      <p>
        <strong>CAZALIA</strong>, entreprise individuelle exploitée par <strong>Lucie Cazanave Pin</strong>,
        SIREN <strong>109&nbsp;422&nbsp;121</strong> (R.C.S. Montpellier), siège&nbsp;: 99 rue du Faubourg
        Boutonnet, 34090 Montpellier. TVA non applicable, article 293&nbsp;B du Code général des impôts.
        Contact&nbsp;: <a href="mailto:contact@cazalia.fr">contact@cazalia.fr</a> -{' '}
        <a href="tel:+33766211483">07&nbsp;66&nbsp;21&nbsp;14&nbsp;83</a>.
      </p>

      <h2 id="champ">2. Champ d'application (B2C / B2B)</h2>
      <p>
        Les CGV s'appliquent à toute commande passée via le service. Certaines règles diffèrent selon la
        qualité de l'acheteur&nbsp;:
      </p>
      <ul>
        <li><strong>Consommateur (B2C)</strong> : personne physique agissant à des fins n'entrant pas dans
          le cadre de son activité professionnelle. Bénéficie des protections du Code de la consommation
          (information précontractuelle, droit de rétractation, médiation).</li>
        <li><strong>Professionnel (B2B)</strong> : personne agissant à des fins professionnelles
          (indépendant, entreprise). Le droit de rétractation et la médiation de la consommation ne
          s'appliquent pas&nbsp;; des règles propres au Code de commerce s'y substituent (article 9).</li>
      </ul>
      <p>
        La qualité de l'acheteur est appréciée au moment de la commande, le cas échéant au vu des
        informations de facturation renseignées (dénomination, n° de TVA).
      </p>

      <h2 id="offres">3. Offres et prix</h2>
      <p>
        Les réservations d'espaces (postes en open-space, bureaux, salles) sont <strong>payées à l'acte, en
        euros</strong>, au tarif affiché. L'Éditeur propose également des <strong>abonnements mensuels</strong>
        ouvrant droit, selon la formule, à un quota ou à un accès illimité à certains espaces. Les
        caractéristiques essentielles de chaque offre et son prix sont présentés avant la validation de la
        commande.
      </p>
      <p>
        Les prix sont indiqués en euros, <strong>toutes taxes comprises</strong> (TVA non applicable, art.
        293&nbsp;B du CGI). L'Éditeur peut modifier ses prix à tout moment&nbsp;; le prix applicable est
        celui affiché au moment de la commande, sans effet sur les commandes déjà validées.
      </p>

      <h2 id="commande">4. Commande et formation du contrat</h2>
      <p>
        L'acheteur sélectionne son offre ou compose son panier de réservations, vérifie le détail et le
        montant, puis valide. Avant le paiement, il doit accepter les présentes CGV (case à cocher). La
        vente est <strong>définitivement conclue</strong> à la confirmation du paiement (ou, pour une
        réservation couverte par l'abonnement, à la validation de la réservation). Un récapitulatif lui est adressé.
      </p>
      <p>
        <strong>Réservation préalable obligatoire.</strong> L'accès à tout espace (poste en open space,
        salle de réunion) est subordonné à la <strong>réservation préalable d'un créneau daté</strong> via
        la plateforme, dans la limite des places et des disponibilités. Cette obligation s'applique à tous
        les utilisateurs, <strong>y compris les titulaires d'un abonnement</strong>&nbsp;: l'abonnement
        confère un droit d'accès et des conditions tarifaires, mais ne vaut pas réservation et ne garantit
        pas de place sans créneau réservé. La salle de réunion doit être réservée pour <strong>toute
        durée</strong> (heure, demi-journée ou journée). Cette règle vise à garantir la disponibilité des
        espaces et le confort de chacun.
      </p>

      <h2 id="paiement">5. Paiement</h2>
      <p>
        Le paiement en ligne est assuré par <strong>Stripe</strong> (Stripe Payments Europe, Ltd),
        prestataire de paiement sécurisé. Les données de carte bancaire sont saisies sur l'environnement
        sécurisé de Stripe et ne sont jamais stockées par l'Éditeur. Les paiements font l'objet d'une
        authentification forte (DSP2 / 3-D&nbsp;Secure). Les abonnements mensuels sont prélevés
        automatiquement à chaque échéance jusqu'à leur résiliation.
      </p>
      <p>
        L'abonné peut <strong>résilier son abonnement à tout moment</strong>, directement depuis son
        espace client. La résiliation prend effet <strong>au terme de la période mensuelle déjà
        réglée</strong> : l'accès et les droits associés à la formule restent ouverts jusqu'à cette
        date, et aucun prélèvement n'est effectué ensuite. La période en cours, déjà payée,
        <strong>n'est pas remboursée, même partiellement</strong>. Tant que ce terme n'est pas atteint,
        l'abonné peut revenir sur sa résiliation depuis le même écran.
      </p>

      <h2 id="facturation">6. Facturation et TVA</h2>
      <p>
        Un reçu est mis à disposition de l'acheteur pour chaque paiement. En application de l'article
        293&nbsp;B du CGI, la <strong>TVA n'est pas applicable</strong>
        et n'est donc pas facturée.
      </p>

      <h2 id="retractation">7. Droit de rétractation (consommateurs)</h2>
      <p>
        Le consommateur dispose en principe d'un délai de <strong>quatorze (14) jours</strong> à compter de
        la conclusion du contrat pour exercer son droit de rétractation, sans motif (art. L221-18 s. du Code
        de la consommation), au moyen du{' '}
        <Link to="/reclamation">formulaire de réclamation</Link> ou de toute déclaration dénuée
        d'ambiguïté. Les sommes versées pour des prestations non encore exécutées sont alors remboursées.
      </p>
      <p>
        Toutefois, conformément à l'article L221-28, 12° du Code de la consommation, le droit de
        rétractation <strong>ne s'applique pas</strong> aux prestations de services de loisirs fournies à
        une date ou selon une périodicité déterminée (réservation d'un créneau daté). En outre, lorsque le
        consommateur <strong>demande l'exécution immédiate</strong> de la prestation avant la fin du délai
        de 14&nbsp;jours (en réservant un créneau) et en accepte expressément le principe, il reconnaît
        perdre son droit de rétractation pour les prestations pleinement exécutées et rester redevable du
        montant correspondant aux prestations déjà fournies (art. L221-25).
      </p>

      <h2 id="annulation">8. Annulation, report et remboursement</h2>
      <p>Sauf conditions particulières affichées lors de la réservation&nbsp;:</p>
      <ul>
        <li><strong>Annulation plus de 48&nbsp;heures avant</strong> le créneau&nbsp;: remboursement
          intégral.</li>
        <li><strong>Annulation entre 48&nbsp;heures et 24&nbsp;heures avant</strong>&nbsp;: remboursement
          (sauf mention contraire pour les salles privatisées).</li>
        <li><strong>Annulation moins de 24&nbsp;heures avant, ou absence (no-show)</strong>&nbsp;: le
          montant reste dû.</li>
        <li><strong>Annulation par l'Éditeur</strong> (fermeture, indisponibilité, force majeure)&nbsp;:
          remboursement intégral des sommes versées pour les créneaux concernés.</li>
      </ul>
      <p>
        Un report peut être proposé selon les disponibilités. En cas de remboursement en numéraire d'une
        somme réglée en ligne, le remboursement est effectué via Stripe sur le moyen de paiement d'origine,
        généralement sous <strong>5 à 10 jours ouvrés</strong>. Toute demande s'effectue via le{' '}
        <Link to="/reclamation">formulaire de réclamation</Link>.
      </p>

      <h2 id="retard">9. Retard de paiement (professionnels)</h2>
      <p>
        Entre professionnels, tout retard de paiement entraîne de plein droit des pénalités de retard au
        taux d'intérêt de la Banque centrale européenne majoré de 10&nbsp;points, ainsi qu'une
        <strong> indemnité forfaitaire de 40&nbsp;€</strong> pour frais de recouvrement (art. L441-10 et
        D441-5 du Code de commerce), sans préjudice de tout autre recours.
      </p>

      <h2 id="responsabilite">10. Responsabilité et force majeure</h2>
      <p>
        L'Éditeur est tenu d'une obligation de moyens quant à la mise à disposition des espaces. Sa
        responsabilité est limitée aux dommages directs et prévisibles, sans que cette limitation ne joue
        lorsque la loi l'interdit, notamment à l'égard des consommateurs. Aucune des parties n'est
        responsable d'un manquement dû à un cas de force majeure au sens de l'article 1218 du Code civil.
      </p>

      <h2 id="mediation">11. Réclamations et médiation</h2>
      <p>
        Toute réclamation peut être adressée via le <Link to="/reclamation">formulaire dédié</Link> ou à{' '}
        <a href="mailto:contact@cazalia.fr">contact@cazalia.fr</a>. Une solution amiable est recherchée en
        priorité. Conformément aux articles L612-1 et suivants du Code de la consommation, le consommateur
        peut recourir gratuitement à un médiateur de la consommation&nbsp;:
      </p>
      <p>
        <strong>[Médiateur de la consommation - à compléter : nom, adresse postale et site internet]</strong>
        {' '}<em>(dispositif en cours de souscription).</em>
      </p>
      <p>
        La plateforme européenne de règlement en ligne des litiges est accessible à l'adresse{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer">
        ec.europa.eu/consumers/odr</a>.
      </p>

      <h2 id="droit">12. Droit applicable et litiges</h2>
      <p>
        Les présentes CGV sont soumises au droit français. À défaut de résolution amiable, le litige sera
        porté devant les juridictions compétentes. Lorsque l'acheteur est un consommateur, les règles de
        compétence protectrices du Code de la consommation et du Code de procédure civile s'appliquent.
      </p>

      <p className="muted" style={{ marginTop: 32 }}>
        <BackLink to="/" label="Retour à l'accueil" />
      </p>
    </div>
  );
}
