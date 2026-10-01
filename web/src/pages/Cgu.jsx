import BackLink from '../components/BackLink.jsx';

// Conditions Générales d'Utilisation + mentions légales + politique de confidentialité (RGPD).
// Mentions légales renseignées (CAZALIA — EI Lucie Cazanave Pin, SIREN 109 422 121).
// Reste à compléter plus tard : l'adresse e-mail de contact (en cours de création),
// définie à l'article 3 et référencée partout ailleurs.
export default function Cgu() {
  return (
    <div className="legal">
      <BackLink to="/" label="Retour à l'accueil" />
      <img src="/images/logo-cazalia.svg" className="legal-logo" alt="CAZALIA — Coworking Boutonnet" />
      <h1>Conditions générales d'utilisation</h1>
      <p className="muted">Dernière mise à jour : octobre 2026.</p>

      <p>
        Les présentes conditions générales d'utilisation (les « <strong>CGU</strong> ») regroupent
        également les <strong>mentions légales</strong> et la <strong>politique de confidentialité</strong>
        du service. Elles constituent un document unique régissant l'ensemble de la relation entre
        CAZALIA — Coworking Boutonnet et ses utilisateurs.
      </p>

      <nav className="legal-toc" aria-label="Sommaire">
        <p><strong>Sommaire</strong></p>
        <ol>
          <li><a href="#definitions">Définitions</a></li>
          <li><a href="#objet">Objet et acceptation</a></li>
          <li><a href="#mentions">Mentions légales</a></li>
          <li><a href="#service">Description du Service</a></li>
          <li><a href="#compte">Accès au Service et compte utilisateur</a></li>
          <li><a href="#securite-compte">Sécurité du compte</a></li>
          <li><a href="#reservations">Réservations</a></li>
          <li><a href="#credits">Crédits, tarifs et paiement</a></li>
          <li><a href="#annulation">Annulation, modification et remboursement</a></li>
          <li><a href="#retractation">Droit de rétractation</a></li>
          <li><a href="#preinscription">Pré-inscription (liste d'attente)</a></li>
          <li><a href="#reglement">Règles d'utilisation des espaces</a></li>
          <li><a href="#wifi">Accès Internet et Wi-Fi</a></li>
          <li><a href="#communications">Communications électroniques</a></li>
          <li><a href="#obligations">Obligations de l'utilisateur</a></li>
          <li><a href="#suspension">Suspension et résiliation</a></li>
          <li><a href="#disponibilite">Disponibilité et responsabilité</a></li>
          <li><a href="#confidentialite">Protection des données personnelles (RGPD)</a></li>
          <li><a href="#cookies">Cookies</a></li>
          <li><a href="#pi">Propriété intellectuelle</a></li>
          <li><a href="#force-majeure">Force majeure</a></li>
          <li><a href="#modification">Modification des CGU</a></li>
          <li><a href="#divers">Dispositions diverses</a></li>
          <li><a href="#mediation">Réclamations et médiation</a></li>
          <li><a href="#litiges">Droit applicable et litiges</a></li>
        </ol>
      </nav>

      <h2 id="definitions">1. Définitions</h2>
      <ul>
        <li><strong>Service</strong> : la plateforme en ligne accessible à l'adresse cowork.lokyron.fr,
          permettant de découvrir l'espace, créer un compte, réserver des espaces et gérer un solde de crédits.</li>
        <li><strong>Éditeur</strong> / <strong>Exploitant</strong> : la structure identifiée à l'article
          « Mentions légales », qui édite le Service et exploite l'espace de coworking.</li>
        <li><strong>Utilisateur</strong> : toute personne qui accède au Service, qu'elle dispose ou non d'un compte.</li>
        <li><strong>Membre</strong> : utilisateur titulaire d'un compte.</li>
        <li><strong>Espace</strong> : poste en open-space, bureau ou salle réservable au sein du lieu.</li>
        <li><strong>Crédit</strong> : unité interne de réservation, créditée au compte du Membre et débitée
          lors d'une réservation.</li>
        <li><strong>Lieu</strong> : l'espace physique de coworking exploité à Boutonnet (Montpellier).</li>
      </ul>

      <h2 id="objet">2. Objet et acceptation</h2>
      <p>
        Les présentes CGU encadrent l'accès et l'utilisation du Service. Elles s'appliquent à l'exclusion
        de tout autre document. L'utilisation du Service, et en particulier la création d'un compte,
        emporte acceptation pleine et entière des présentes CGU. L'utilisateur qui n'accepte pas les CGU
        doit renoncer à utiliser le Service.
      </p>
      <p>
        L'accès physique au Lieu et à ses équipements est en outre soumis au règlement intérieur
        (article 12), qui fait partie intégrante des présentes.
      </p>

      <h2 id="mentions">3. Mentions légales</h2>
      <p>
        Le Service est édité par <strong>CAZALIA</strong>, entreprise individuelle
        (micro-entreprise) exploitée par <strong>Lucie Cazanave Pin</strong>, immatriculée au Registre du
        commerce et des sociétés de Montpellier sous le numéro SIREN <strong>109&nbsp;422&nbsp;121</strong>
        (SIRET du siège&nbsp;109&nbsp;422&nbsp;121&nbsp;00011 ; RCS&nbsp;109&nbsp;422&nbsp;121 R.C.S. Montpellier).
        TVA non applicable, article 293&nbsp;B du Code général des impôts. Siège social :
        <strong> 99 rue du Faubourg Boutonnet, 34090 Montpellier</strong>.
      </p>
      <p>
        Le Lieu est exploité à cette même adresse : 99 rue du Faubourg Boutonnet, 34090 Montpellier
        (quartier Boutonnet).
      </p>
      <p>
        Directrice de la publication : <strong>Lucie Cazanave Pin</strong>.
        Contact : <em>adresse e-mail en cours de création (sera précisée ici prochainement)</em>.
      </p>
      <p>
        Le Service est hébergé par <strong>CAZALIA</strong> en auto-hébergement, dans ses locaux au
        99 rue du Faubourg Boutonnet, 34090 Montpellier.
      </p>

      <h2 id="service">4. Description du Service</h2>
      <p>Le Service permet notamment :</p>
      <ul>
        <li>de consulter la présentation du Lieu, des espaces et de la galerie photos ;</li>
        <li>de créer et gérer un compte membre et son profil ;</li>
        <li>de consulter les disponibilités en temps réel et de réserver un ou plusieurs espaces ;</li>
        <li>de gérer un solde de crédits et de consulter l'historique des réservations et mouvements ;</li>
        <li>d'éditer un relevé de compte au format PDF ;</li>
        <li>de recevoir des notifications et confirmations par courrier électronique ;</li>
        <li>le cas échéant, d'obtenir un accès Wi-Fi associé à une réservation.</li>
      </ul>
      <p>
        L'Éditeur se réserve le droit de faire évoluer, d'ajouter ou de supprimer des fonctionnalités à
        tout moment, dans le respect des présentes.
      </p>

      <h2 id="compte">5. Accès au Service et compte utilisateur</h2>
      <p>
        La consultation des pages publiques est libre. Certaines fonctionnalités (réservation, solde de
        crédits) nécessitent la création d'un compte. La création d'un compte est réservée aux personnes
        majeures disposant de la capacité juridique de contracter.
      </p>
      <p>
        L'utilisateur s'engage à fournir des informations exactes (prénom, nom, adresse e-mail, numéro de
        téléphone) et à les tenir à jour. L'Éditeur peut refuser ou clôturer un compte comportant des
        informations manifestement fausses, incomplètes ou frauduleuses.
      </p>
      <p>
        L'utilisateur peut modifier ses informations et supprimer son compte à tout moment depuis son
        espace. La suppression du compte entraîne l'effacement des données associées, sous réserve des
        durées de conservation légales (notamment comptables) et de la conservation des données
        strictement nécessaires à la constatation, l'exercice ou la défense de droits en justice.
      </p>

      <h2 id="securite-compte">6. Sécurité du compte</h2>
      <p>
        Chaque compte est personnel. L'utilisateur est seul responsable de la confidentialité de ses
        identifiants et de toute activité réalisée depuis son compte. Il s'engage à choisir un mot de
        passe robuste et à ne pas le partager. Une authentification à deux facteurs (2FA) peut être
        activée pour renforcer la sécurité. En cas d'utilisation non autorisée de son compte,
        l'utilisateur doit en informer sans délai l'Éditeur et modifier son mot de passe.
      </p>

      <h2 id="reservations">7. Réservations</h2>
      <p>
        Les réservations d'espaces s'effectuent en ligne. Les disponibilités sont affichées en temps réel.
        Une réservation n'est <strong>confirmée qu'une fois les crédits correspondants débités</strong> du
        solde du Membre. Plusieurs espaces peuvent être réservés en une seule opération (panier).
      </p>
      <p>
        Le Membre s'engage à utiliser l'espace réservé conformément à sa destination et au règlement
        intérieur, et pour la seule durée réservée. L'Éditeur peut fixer des règles particulières
        (durée minimale, plages horaires, nombre de places) affichées lors de la réservation.
      </p>

      <h2 id="credits">8. Crédits, tarifs et paiement</h2>
      <p>
        Les réservations sont décomptées d'un solde de <strong>crédits</strong>. Les crédits sont
        rechargeables. Ils <strong>n'ont pas de valeur monétaire</strong>, ne sont ni remboursables en
        numéraire ni cessibles ou transférables à un tiers, et sont utilisables exclusivement au sein de
        CAZALIA — Coworking Boutonnet.
      </p>
      <p>
        Les tarifs applicables (grille d'achat de crédits et coût en crédits des espaces) sont ceux
        affichés sur le Service au moment de l'opération. Les prix sont indiqués en euros&nbsp;; TVA non
        applicable, article 293&nbsp;B du Code général des impôts. L'Éditeur peut modifier ses tarifs à tout
        moment ; les modifications sont sans effet sur les opérations déjà validées. Une facture ou un
        relevé est mis à disposition du Membre.
      </p>
      <p>
        À ce jour, le rechargement des crédits est effectué par l'Éditeur selon les modalités convenues sur
        place. En cas de mise en place ultérieure d'un paiement en ligne, celui-ci serait assuré par un
        prestataire de paiement sécurisé et l'Éditeur n'aurait pas accès aux données complètes de carte
        bancaire&nbsp;; les présentes CGU seraient mises à jour en conséquence.
      </p>

      <h2 id="annulation">9. Annulation, modification et remboursement</h2>
      <p>
        Sauf conditions particulières affichées lors de la réservation, l'annulation par le Membre donne
        lieu au <strong>recréditation des crédits</strong> si elle intervient <strong>plus de
        24&nbsp;heures</strong> avant le début du créneau. Passé ce délai, les crédits restent dus. Une
        annulation à l'initiative de l'Éditeur (fermeture, indisponibilité, force majeure) donne lieu à un
        recréditation intégral des crédits concernés.
      </p>

      <h2 id="retractation">10. Droit de rétractation</h2>
      <p>
        Lorsque l'utilisateur agit en qualité de <strong>consommateur</strong> au sens du Code de la
        consommation et que l'achat de crédits est conclu à distance, il dispose en principe d'un délai de
        <strong> quatorze (14) jours</strong> pour se rétracter, sans avoir à motiver sa décision.
      </p>
      <p>
        Conformément à l'article L.221-25 du Code de la consommation, le Membre qui demande l'exécution du
        Service (notamment une réservation) avant la fin du délai de rétractation reconnaît que, en cas de
        rétractation, il restera redevable du montant correspondant aux prestations déjà fournies.
        Le droit de rétractation ne peut plus être exercé pour les prestations de service pleinement
        exécutées avant la fin du délai avec l'accord préalable exprès du consommateur.
      </p>

      <h2 id="preinscription">11. Pré-inscription (liste d'attente)</h2>
      <p>
        Avant l'ouverture, le Service propose un formulaire de pré-inscription permettant de laisser ses
        coordonnées afin d'être recontacté et de bénéficier, le cas échéant, d'une journée découverte
        offerte. La pré-inscription est gratuite, sans engagement, et ne vaut ni réservation ni promesse
        de contrat.
      </p>

      <h2 id="reglement">12. Règles d'utilisation des espaces (règlement intérieur)</h2>
      <p>En accédant au Lieu, l'utilisateur s'engage à :</p>
      <ul>
        <li>respecter les horaires d'ouverture et les conditions d'accès communiqués par l'Éditeur ;</li>
        <li>adopter un comportement courtois et respectueux envers les autres occupants et le personnel,
          et préserver le calme nécessaire au travail ;</li>
        <li>utiliser le mobilier, le matériel et les équipements avec soin, et laisser les espaces propres
          et rangés après usage ;</li>
        <li>ne pas céder, sous-louer ou partager son accès, et ne pas introduire de tiers non déclarés
          dans les espaces privatifs ;</li>
        <li>respecter les consignes de sécurité et d'évacuation, ne pas encombrer les issues de secours ;</li>
        <li>ne stocker aucun bien de valeur : l'Éditeur décline toute responsabilité en cas de perte,
          de vol ou de détérioration des effets personnels ;</li>
        <li>s'abstenir de toute activité illicite, dangereuse, nuisible ou contraire à l'ordre public.</li>
      </ul>
      <p>
        Tout dommage causé aux locaux ou aux équipements engage la responsabilité de son auteur. Le
        non-respect du règlement intérieur peut entraîner l'exclusion temporaire ou définitive du Lieu,
        sans remboursement.
      </p>

      <h2 id="wifi">13. Accès Internet et Wi-Fi</h2>
      <p>
        Un accès à Internet par Wi-Fi peut être mis à disposition, le cas échéant via un code ou un accès
        associé à une réservation. L'utilisateur s'engage à un usage raisonnable, licite et conforme au
        présent document. Il est seul responsable des contenus auxquels il accède, qu'il publie ou qu'il
        échange. L'Éditeur peut suspendre l'accès en cas d'usage abusif, frauduleux ou portant atteinte à
        la sécurité ou à la qualité du réseau, et ne garantit ni un débit ni une continuité de service.
      </p>

      <h2 id="communications">14. Communications électroniques</h2>
      <p>
        Dans le cadre de l'utilisation du Service, l'Éditeur adresse au Membre des courriers électroniques
        <strong> transactionnels</strong> nécessaires au fonctionnement (confirmation et modification de
        réservation, réinitialisation de mot de passe, information de compte). Ces messages ne constituent
        pas de la prospection commerciale. Toute communication à caractère promotionnel éventuelle ne
        serait adressée qu'avec le consentement du Membre et comporterait un lien de désinscription.
      </p>

      <h2 id="obligations">15. Obligations de l'utilisateur</h2>
      <p>L'utilisateur s'interdit notamment de :</p>
      <ul>
        <li>porter atteinte au fonctionnement, à la sécurité ou à l'intégrité du Service ;</li>
        <li>tenter d'accéder à des comptes ou à des données qui ne lui appartiennent pas ;</li>
        <li>utiliser des moyens automatisés non autorisés (robots, extraction massive de données) ;</li>
        <li>usurper l'identité d'un tiers ou fournir des informations trompeuses ;</li>
        <li>utiliser le Service à des fins illicites ou contraires aux présentes CGU.</li>
      </ul>

      <h2 id="suspension">16. Suspension et résiliation</h2>
      <p>
        En cas de manquement aux présentes CGU ou au règlement intérieur, l'Éditeur peut, après mise en
        demeure restée sans effet lorsque la nature du manquement le permet, suspendre ou clôturer le
        compte concerné et/ou l'accès au Lieu. Les manquements graves (atteinte à la sécurité, fraude,
        comportement dangereux) peuvent justifier une mesure immédiate. Le Membre peut de son côté
        supprimer son compte à tout moment depuis son espace.
      </p>

      <h2 id="disponibilite">17. Disponibilité et responsabilité</h2>
      <p>
        L'Éditeur met en œuvre les moyens raisonnables pour assurer la disponibilité et le bon
        fonctionnement du Service, sans garantie d'absence d'interruption, et peut procéder à des
        opérations de maintenance. La responsabilité de l'Éditeur ne saurait être engagée en cas d'usage
        non conforme du Service, de faute de l'utilisateur, du fait d'un tiers ou de force majeure. En
        toute hypothèse, la responsabilité de l'Éditeur est limitée aux dommages directs et prévisibles.
        Aucune stipulation des présentes ne vise à exclure ou limiter la responsabilité de l'Éditeur
        lorsque la loi l'interdit, notamment à l'égard des consommateurs.
      </p>

      <h2 id="confidentialite">18. Protection des données personnelles (RGPD)</h2>
      <p>
        CAZALIA accorde une grande importance à la protection de vos données et s'engage à les traiter
        conformément au Règlement général sur la protection des données (RGPD) et à la loi
        « Informatique et Libertés ». Le responsable de traitement est l'Éditeur identifié à l'article 3.
      </p>
      <p><strong>Données collectées :</strong></p>
      <ul>
        <li><strong>Compte membre</strong> : prénom, nom, adresse e-mail, numéro de téléphone, mot de
          passe (stocké chiffré), historique des réservations et des mouvements de crédits.</li>
        <li><strong>Pré-inscription</strong> : prénom, nom, adresse e-mail, numéro de téléphone,
          activité (facultative) et consentement au recontact.</li>
        <li><strong>Données techniques</strong> : cookie de session strictement nécessaire au
          fonctionnement, et journaux techniques (connexions, événements de sécurité) dans lesquels
          l'adresse e-mail n'est pas inscrite en clair.</li>
      </ul>
      <p><strong>Finalités et bases légales :</strong> gestion des comptes et des réservations
        (exécution du contrat) ; facturation et relevés (obligation légale) ; recontact des personnes
        pré-inscrites et envoi d'éventuelles communications (consentement) ; sécurité, prévention de la
        fraude et amélioration du Service (intérêt légitime).</p>
      <p><strong>Destinataires :</strong> les données sont destinées à l'usage interne de CAZALIA.
        Elles ne sont ni vendues ni cédées à des tiers à des fins commerciales. Interviennent, le cas
        échéant, des prestataires techniques (hébergement, envoi d'e-mails, paiement) agissant comme
        <strong> sous-traitants</strong> sur instruction de l'Éditeur et tenus à la confidentialité.</p>
      <p><strong>Transferts hors UE :</strong> les données sont hébergées au sein de l'Union européenne.
        En l'absence de transfert hors UE, aucune garantie spécifique n'est requise ; dans le cas
        contraire, des garanties appropriées (clauses contractuelles types) seraient mises en place.</p>
      <p><strong>Durée de conservation :</strong> les données de compte sont conservées tant que le
        compte est actif, puis archivées selon les durées légales applicables (notamment comptables) ;
        les données de pré-inscription sont conservées jusqu'au retrait du consentement ou à l'issue de la
        campagne d'ouverture ; les journaux techniques sont conservés pour une durée limitée à des fins de
        sécurité.</p>
      <p><strong>Vos droits :</strong> vous disposez d'un droit d'accès, de rectification, d'effacement,
        de limitation, d'opposition et de portabilité de vos données, ainsi que du droit de définir des
        directives relatives à leur sort après votre décès. Vous pouvez les exercer à tout moment en
        écrivant à l'Éditeur (coordonnées à l'article 3 «&nbsp;Mentions légales&nbsp;»). Vous pouvez
        également introduire une réclamation auprès de la CNIL (<a href="https://www.cnil.fr"
        target="_blank" rel="noopener noreferrer">www.cnil.fr</a>).</p>
      <p><strong>Sécurité :</strong> les mots de passe sont stockés sous forme chiffrée, les échanges sont
        sécurisés (HTTPS), une double authentification est proposée et des mesures techniques et
        organisationnelles sont mises en œuvre pour protéger les données.</p>

      <h2 id="cookies">19. Cookies</h2>
      <p>
        Le Service utilise un cookie de session strictement nécessaire au maintien de la connexion, qui ne
        requiert pas de consentement préalable. Aucun cookie publicitaire n'est déposé. Si des outils de
        mesure d'audience ou de tiers étaient ajoutés ultérieurement, un bandeau de consentement serait
        mis en place conformément à la réglementation et aux recommandations de la CNIL.
      </p>

      <h2 id="pi">20. Propriété intellectuelle</h2>
      <p>
        La marque CAZALIA, le logo, la charte graphique, les textes, photographies et l'ensemble des
        contenus du Service sont protégés et demeurent la propriété exclusive de leur titulaire. Toute
        reproduction, représentation ou utilisation, totale ou partielle, sans autorisation préalable
        écrite, est interdite. L'utilisateur bénéficie d'un droit d'usage personnel et non exclusif du
        Service, limité à ses besoins propres.
      </p>

      <h2 id="force-majeure">21. Force majeure</h2>
      <p>
        La responsabilité de l'Éditeur ne saurait être recherchée en cas d'inexécution ou de retard dû à
        un événement de force majeure au sens de l'article 1218 du Code civil et de la jurisprudence
        applicable (notamment catastrophe, incendie, panne généralisée des réseaux, décision des
        autorités).
      </p>

      <h2 id="modification">22. Modification des CGU</h2>
      <p>
        Les présentes CGU peuvent être modifiées à tout moment afin de refléter les évolutions du Service
        ou de la réglementation. La version applicable est celle en vigueur à la date d'utilisation du
        Service. En cas de modification substantielle, les Membres en sont informés par un moyen approprié.
        La poursuite de l'utilisation du Service vaut acceptation des CGU modifiées.
      </p>

      <h2 id="divers">23. Dispositions diverses</h2>
      <p>
        Si l'une des stipulations des présentes CGU était déclarée nulle ou inapplicable, les autres
        stipulations conserveraient leur plein effet. Le fait pour l'Éditeur de ne pas se prévaloir d'un
        manquement ne vaut pas renonciation à s'en prévaloir ultérieurement. Les présentes CGU sont
        rédigées en langue française, qui prévaut en cas de traduction. Les registres informatisés de
        l'Éditeur sont admis comme preuve des opérations réalisées via le Service.
      </p>

      <h2 id="mediation">24. Réclamations et médiation</h2>
      <p>
        Pour toute réclamation, l'utilisateur peut contacter l'Éditeur aux coordonnées figurant à
        l'article 3 «&nbsp;Mentions légales&nbsp;». Une solution amiable sera recherchée
        en priorité. Conformément au Code de la consommation, le consommateur a le droit de recourir
        gratuitement à un médiateur de la consommation en vue de la résolution amiable du litige&nbsp;; les
        coordonnées du médiateur compétent lui seront communiquées par l'Éditeur sur simple demande. La
        plateforme européenne de règlement en ligne des litiges est par ailleurs accessible à l'adresse
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noopener noreferrer">
        ec.europa.eu/consumers/odr</a>.
      </p>

      <h2 id="litiges">25. Droit applicable et litiges</h2>
      <p>
        Les présentes CGU sont soumises au droit français. À défaut de résolution amiable, le litige sera
        porté devant les juridictions compétentes dans les conditions prévues par la loi. Lorsque
        l'utilisateur est un consommateur, les règles de compétence protectrices prévues par le Code de la
        consommation et le Code de procédure civile s'appliquent.
      </p>

      <p className="muted" style={{ marginTop: 32 }}>
        <BackLink to="/" label="Retour à l'accueil" />
      </p>
    </div>
  );
}
